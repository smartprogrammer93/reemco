/**
 * REEA-1140 — the PDP side of card ↔ detail continuity.
 *
 * The results card carries the query it was collected for; the detail page must
 * re-run that SAME live fan-out and select the group by its canonical SKU slug.
 * A slug-only visit (legacy link, sitemap) still resolves by canonical fields,
 * but it must prefer the storage tier the slug names — the defect that rendered
 * a 512 GB PDP with the 256 GB title.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedProduct } from "@/types/product";

const mocks = vi.hoisted(() => ({
  collectLiveResults: vi.fn(),
  collectLiveResultsStagedAdmitted: vi.fn(),
  readLiveQueryMemo: vi.fn(),
  readRetiredLanes: vi.fn(),
}));

// REEA-1192 — the PDP now inherits a query memo when the shelf just served it
// and otherwise takes the admitted staged path bounded to the page completion
// budget. These pins exercise the dispatch half, so the memo is a miss and the
// staged entry resolves to the same canned fan-out answer the old mock returned.
vi.mock("@/lib/collect/live-search", () => ({
  collectLiveResults: mocks.collectLiveResults,
  collectLiveResultsStagedAdmitted: mocks.collectLiveResultsStagedAdmitted,
  readLiveQueryMemo: mocks.readLiveQueryMemo,
  RESULTS_COMPLETION_BUDGET_MS: 1_800,
  STAGE_TAIL_HEADROOM_MS: 6_200,
}));
vi.mock("@/lib/collect/lane-health", () => ({
  readRetiredLanes: mocks.readRetiredLanes,
}));

const { resolveProductIdentity } = await import("@/lib/product-identity");

function product(
  productId: string,
  title: string,
  offers: Array<{ merchant: string; price: number; url: string }>,
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers: offers.map((o) => ({
      merchant: o.merchant,
      price: o.price,
      currency: "KWD",
      url: o.url,
      inStock: true,
    })),
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: new Date().toISOString(),
  };
}

const FOLD7_256 = product(
  "samsung-galaxy-z-fold7-256gb",
  "Samsung Galaxy Z Fold7, 5G, 12 GB RAM",
  [
    {
      merchant: "Xcite",
      price: 379.9,
      url: "https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p",
    },
  ],
);
const FOLD7_512 = product(
  "samsung-galaxy-z-fold7-512gb",
  "Samsung Galaxy Z Fold7  5G 512Phone - Black",
  [
    {
      merchant: "Eureka",
      price: 526.7,
      url: "https://www.eureka.com.kw/products/details/265285",
    },
  ],
);
const DUALSENSE = product(
  "sony-dualsense-controller",
  "Sony PS5 DualSense Wireless Controller",
  [
    {
      merchant: "Wibi",
      price: 20.9,
      url: "https://wibi.com.kw/products/sony-ps5-dualsense-wireless-controller-starlight-blue",
    },
    {
      merchant: "Blink",
      price: 25.9,
      url: "https://blink.com.kw/products/sony-ps5-dualsense-wireless-controller-1",
    },
    {
      merchant: "Astore",
      price: 28.9,
      url: "https://astorekw.com/products/sony-ps5-dualsense-wireless-controller-midnight-black",
    },
  ],
);
const HD16 = product(
  "dyson-supersonic-nural-hd16",
  "Dyson Supersonic Nural Hd16 - Ceramic Pink",
  [
    {
      merchant: "Zayoom",
      price: 139,
      url: "https://zayoom.com/products/dyson-supersonic-nural-hd16-ceramic-pink",
    },
  ],
);

beforeEach(() => {
  mocks.collectLiveResults.mockReset();
  mocks.collectLiveResultsStagedAdmitted.mockReset();
  mocks.readLiveQueryMemo.mockReset();
  mocks.readRetiredLanes.mockReset();
  mocks.readRetiredLanes.mockResolvedValue(new Set<string>());
  mocks.readLiveQueryMemo.mockReturnValue(null);
  mocks.collectLiveResultsStagedAdmitted.mockImplementation(async (query: string) => {
    const answer = await mocks.collectLiveResults(query);
    return { final: Promise.resolve(answer), converged: Promise.resolve(answer) };
  });
});

describe("REEA-1140 — the PDP re-runs the card's query, not a slug guess", () => {
  it("uses the carried results query so the merged group is the same one", async () => {
    mocks.collectLiveResults.mockResolvedValue({ products: [DUALSENSE] });
    const resolved = await resolveProductIdentity(
      "sony-dualsense-controller",
      null,
      "ps5",
    );
    expect(resolved?.productId).toBe("sony-dualsense-controller");
    // First (and decisive) fan-out is the shopper's own query, not
    // "sony dualsense controller" decoded from the slug.
    expect(mocks.collectLiveResults.mock.calls[0][0]).toBe("ps5");
    expect(resolved?.offers.map((o) => o.merchant)).toEqual([
      "Wibi",
      "Blink",
      "Astore",
    ]);
  });

  it("resolves an exact canonical slug from the carried query", async () => {
    mocks.collectLiveResults.mockResolvedValue({ products: [FOLD7_256, FOLD7_512] });
    const resolved = await resolveProductIdentity(
      "samsung-galaxy-z-fold7-512gb",
      null,
      "fold 7",
    );
    expect(resolved?.productId).toBe("samsung-galaxy-z-fold7-512gb");
    expect(resolved?.title).toBe("Samsung Galaxy Z Fold7  5G 512Phone - Black");
  });

  it("keeps a slug-only HD16 visit on the merged HD16 group", async () => {
    mocks.collectLiveResults.mockResolvedValue({ products: [HD16] });
    const resolved = await resolveProductIdentity(
      "dyson-supersonic-nural-hd16",
      null,
    );
    expect(resolved?.productId).toBe("dyson-supersonic-nural-hd16");
    expect(resolved?.offers).toHaveLength(1);
  });
});

describe("REEA-1140 — a legacy slug must not land on a different storage tier", () => {
  it("resolves the old 512Phone slug to the 512 GB group, never the 256 GB one", async () => {
    mocks.collectLiveResults.mockResolvedValue({ products: [FOLD7_256, FOLD7_512] });
    const resolved = await resolveProductIdentity(
      "samsung-galaxy-z-fold7-5g-512phone-black",
      null,
    );
    expect(resolved?.productId).toBe("samsung-galaxy-z-fold7-512gb");
    expect(resolved?.offers.map((o) => o.merchant)).toEqual(["Eureka"]);
  });

  it("resolves the old 256 GB RAM-only slug to the 256 GB group", async () => {
    mocks.collectLiveResults.mockResolvedValue({ products: [FOLD7_256, FOLD7_512] });
    const resolved = await resolveProductIdentity(
      "samsung-galaxy-z-fold7-5g-12-gb-ram",
      null,
    );
    expect(resolved?.productId).toBe("samsung-galaxy-z-fold7-256gb");
    expect(resolved?.offers.map((o) => o.merchant)).toEqual(["Xcite"]);
  });
});
