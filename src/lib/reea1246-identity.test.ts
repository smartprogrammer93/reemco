/**
 * REEA-1246 AC5 — a catalog identity renders the shelf's live offer set.
 *
 * Live defect on `0947501b`: the sitemap-advertised `/product/iphone-17-pro`
 * short-circuited to the bundled catalog row (Xcite 374.90 + Jarir 395, no
 * collection stamp) and painted "Xcite KD 317.21 Out of stock · 1 retailer
 * answered · 0/2 stores" while the shelf's canonical key
 * `apple-iphone17-pro-256gb` carried six retailers. Two PDP keys, divergent
 * offer sets; crawlers indexed the thin one.
 *
 * These pins hold `resolveProductIdentity` to the live fan-out for a catalog
 * id, the catalog-id URL identity (the canonical URL never forks), and the
 * catalog row as the fail-closed fallback when no live group names the SKU.
 */
import { describe, expect, it, vi } from "vitest";

// Record the dispatch phrase so the bare-slug pin proves the catalog phrase
// (not the live slug's own words) is what the fan-out receives, and let a pin
// hand the fan-out a set with a storage sibling in it.
const captured = vi.hoisted(() => ({
  queries: [] as string[],
  fanProducts: null as unknown[] | null,
}));

vi.mock("@/lib/collect/live-search", () => {
  const liveGroup = {
    productId: "apple-iphone17-pro-256gb",
    title: "Apple iPhone 17 Pro 256Gb Silver",
    brand: "Apple",
    offers: [
      {
        merchant: "Wibi",
        price: 314.9,
        currency: "KWD",
        url: "https://wibi.com.kw/products/apple-iphone-17-pro-256gb",
        inStock: true,
        collectedAt: "2026-11-27T12:00:00.000Z",
      },
      {
        merchant: "Eureka",
        price: 331.9,
        currency: "KWD",
        url: "https://www.eureka.com.kw/products/details/275096",
        inStock: true,
        collectedAt: "2026-11-27T12:00:00.000Z",
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  };
  return {
    readLiveQueryMemo: (query: string) => {
      captured.queries.push(`memo:${query}`);
      return null;
    },
    collectLiveResultsStagedAdmitted: async (query: string) => {
      captured.queries.push(`fan:${query}`);
      const products = captured.fanProducts ?? [liveGroup];
      return {
        final: Promise.resolve({ products }),
        converged: Promise.resolve({ products }),
      };
    },
    RESULTS_COMPLETION_BUDGET_MS: 1,
    STAGE_TAIL_HEADROOM_MS: 1,
  };
});

const { resolveProductIdentity } = await import("@/lib/product-identity");
const { PRODUCTS } = await import("@/lib/feed");

describe("REEA-1246 AC5 — one PDP per SKU", () => {
  it("resolves a catalog id onto the live group that names the same SKU", async () => {
    const resolved = await resolveProductIdentity("iphone-17-pro");
    expect(resolved).not.toBeNull();
    // The URL identity stays the catalog id (the canonical advertised URL).
    expect(resolved?.productId).toBe("iphone-17-pro");
    // The offer set is the LIVE group, not the bundled catalog rows.
    expect(resolved?.offers.map((o) => o.merchant)).toEqual(["Wibi", "Eureka"]);
    const catalog = PRODUCTS.find((p) => p.productId === "iphone-17-pro")!;
    expect(resolved?.offers.map((o) => o.price)).not.toEqual(catalog.offers.map((o) => o.price));
  });

  it("falls back to the catalog row when no live group names the SKU", async () => {
    const resolved = await resolveProductIdentity("ps5-slim-bundle");
    const catalog = PRODUCTS.find((p) => p.productId === "ps5-slim-bundle")!;
    expect(resolved?.productId).toBe("ps5-slim-bundle");
    expect(resolved?.offers).toEqual(catalog.offers);
  });

  it("leaves a live-only slug on the live path (no catalog fold)", async () => {
    const resolved = await resolveProductIdentity("apple-iphone17-pro-256gb", null, "iphone 17 pro");
    expect(resolved?.productId).toBe("apple-iphone17-pro-256gb");
    expect(resolved?.offers.map((o) => o.merchant)).toEqual(["Wibi", "Eureka"]);
  });

  it("a bare visit to a live slug that folds onto a catalog id dispatches the catalog phrase", async () => {
    captured.queries.length = 0;
    const resolved = await resolveProductIdentity("apple-iphone17-pro-256gb");
    expect(resolved?.productId).toBe("apple-iphone17-pro-256gb");
    // "apple iphone17 pro 256gb" missed the shelf memo and painted last-seen
    // rows; the catalog page's own phrase is what the shelf actually served.
    expect(captured.queries).toContain("fan:iphone 17 pro");
    expect(captured.queries).not.toContain("fan:apple iphone17 pro 256gb");
  });

  it("the phrase fold does not drop the slug's storage tier from the canonical match", async () => {
    // REEA-1140 — the catalog phrase ("iphone 17 pro") names no storage, so a
    // fold must not weaken `want`: the slug still asks for 256 GB. The 512 GB
    // sibling sorts FIRST by id here, so only a retained storage constraint
    // (not the productId tie-break) can pick the right group.
    captured.fanProducts = [
      {
        productId: "apple-iphone17-pro-512gb",
        title: "Apple iPhone 17 Pro 512Gb Silver",
        brand: "Apple",
        offers: [
          {
            merchant: "Xcite",
            price: 414.9,
            currency: "KWD",
            url: "https://www.xcite.com/apple-iphone-17-pro-512gb",
            inStock: true,
            collectedAt: "2026-11-27T12:00:00.000Z",
          },
        ],
        coupons: [],
        variations: [],
        alternatives: [],
      },
      {
        productId: "iphone-17-pro-256gb-titanium",
        title: "Apple iPhone 17 Pro 256Gb Titanium",
        brand: "Apple",
        offers: [
          {
            merchant: "Wibi",
            price: 314.9,
            currency: "KWD",
            url: "https://wibi.com.kw/products/apple-iphone-17-pro-256gb",
            inStock: true,
            collectedAt: "2026-11-27T12:00:00.000Z",
          },
        ],
        coupons: [],
        variations: [],
        alternatives: [],
      },
    ];
    try {
      const resolved = await resolveProductIdentity("apple-iphone17-pro-256gb");
      expect(resolved?.productId).toBe("iphone-17-pro-256gb-titanium");
      expect(resolved?.offers.map((o) => o.price)).toEqual([314.9]);
    } finally {
      captured.fanProducts = null;
    }
  });
});
