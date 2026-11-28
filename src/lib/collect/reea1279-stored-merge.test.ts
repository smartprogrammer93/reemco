/**
 * REEA-1279 — the served document must carry the cross-retailer evidence the
 * stored live answer already holds.
 *
 * Measured on the served head `d9e411c9`: a cold `panadol` card painted
 * BinSina + Danube Home while the stored answer held Lulu too, and a cold
 * `ps5` DualSense card painted one in-market lane while the converged answer
 * held six. The cause was the paint chain discarding a replay's products
 * (REEA-1141) while the live flushes only carried the lanes that answered
 * inside the completion budget — so the stored answer's rows never reached a
 * painted card.
 *
 * These tests pin the fix: `mergeStoredOffers` folds a stored answer's rows
 * into the SAME live card (identity first, canonical-key fallback), keeps the
 * live row for a listing both answers returned, marks the stored rows
 * `fromSnapshot` (their own collection clock), adds no product the live run did
 * not rank, and is idempotent. The integration case runs the real staged path
 * with a stale memo and proves the served stage's card carries both merchants.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { createQueryCache, queryCacheKey } from "@/lib/query-cache";
import {
  collectLiveResultsStaged,
  mergeStoredOffers,
  resetDiscoveryCache,
  type LiveSearchResult,
} from "@/lib/collect/live-search";
import { comparisonMerchantCount } from "@/lib/offer-integrity";
import type { NormalizedProduct } from "@/types/product";

const TITLE = "Sony DualSense Wireless Controller PS5";

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    productId: "sony-dualsense-controller-ps5",
    title: TITLE,
    brand: "Sony",
    image: "",
    offers: [],
    ...overrides,
  } as NormalizedProduct;
}

function snap(products: NormalizedProduct[]): LiveSearchResult {
  return {
    products,
    notes: [],
    settled: true,
    collectedAt: "2026-11-28T03:00:00.000Z",
    collectedAtEpochMs: Date.parse("2026-11-28T03:00:00.000Z"),
  };
}

const XCITE_ROW = {
  merchant: "Xcite",
  price: 21.9,
  currency: "KWD",
  url: "https://www.xcite.com/dualsense/p",
  inStock: true,
  collectedAt: "2026-11-28T03:00:00.000Z",
};
const BLINK_ROW = {
  merchant: "Blink",
  price: 22.5,
  currency: "KWD",
  url: "https://blink.com.kw/products/dualsense-ps5",
  inStock: true,
  collectedAt: "2026-11-28T03:00:00.000Z",
};

describe("REEA-1279 — stored answer rows fold into the served card", () => {
  it("adds a stored in-market lane to the live card, marked as a snapshot row", () => {
    const live = snap([product({ offers: [{ ...BLINK_ROW }] })]);
    const stored = snap([product({ offers: [{ ...BLINK_ROW }, { ...XCITE_ROW }] })]);
    const merged = mergeStoredOffers(live, stored);
    expect(merged.products).toHaveLength(1);
    // Live row kept once; the stored Xcite row joins the same card.
    expect(merged.products[0].offers.map((o) => o.merchant)).toEqual(["Blink", "Xcite"]);
    expect(merged.products[0].offers[1].fromSnapshot).toBe(true);
    expect(comparisonMerchantCount(merged.products[0].offers, "KW")).toBe(2);
  });

  it("never adds a product the live run did not rank, and never duplicates a live listing", () => {
    const live = snap([product({ offers: [{ ...BLINK_ROW }] })]);
    const stored = snap([
      product({ offers: [{ ...BLINK_ROW }, { ...XCITE_ROW }] }),
      product({ productId: "sony-dualsense-edge-controller-ps5", title: "Sony DualSense Edge Controller PS5", offers: [{ ...XCITE_ROW }] }),
    ]);
    const merged = mergeStoredOffers(live, stored);
    expect(merged.products.map((p) => p.productId)).toEqual(["sony-dualsense-controller-ps5"]);
    expect(merged.products[0].offers.filter((o) => o.merchant === "Blink")).toHaveLength(1);
  });

  it("matches a stored card written under a different representative title by canonical identity", () => {
    const live = snap([product({ offers: [{ ...BLINK_ROW }] })]);
    const stored = snap([
      product({
        productId: "sony-dualsense-ps5-controller",
        title: "Sony DualSense PS5 Wireless Controller",
        offers: [{ ...XCITE_ROW }],
      }),
    ]);
    const merged = mergeStoredOffers(live, stored);
    expect(comparisonMerchantCount(merged.products[0].offers, "KW")).toBe(2);
  });

  it("is idempotent and passes through untouched when there is no stored answer", () => {
    const live = snap([product({ offers: [{ ...BLINK_ROW }] })]);
    const stored = snap([product({ offers: [{ ...XCITE_ROW }] })]);
    const once = mergeStoredOffers(live, stored);
    const twice = mergeStoredOffers(once, stored);
    expect(twice.products[0].offers.map((o) => o.merchant)).toEqual(["Blink", "Xcite"]);
    expect(mergeStoredOffers(live, null)).toBe(live);
  });
});

describe("REEA-1279 — the staged serve folds the stored answer into its live stage", () => {
  it("a stale-memo serve paints the stored in-market lane on the same card", async () => {
    resetDiscoveryCache();
    const cache = createQueryCache();
    const query = "sony dualsense controller ps5";
    cache.write(
      queryCacheKey(query),
      snap([product({ offers: [{ ...BLINK_ROW }, { ...XCITE_ROW }] })]),
      { stale: true },
    );
    // This run's own live answer: Blink only (Xcite is still in flight when the
    // document finalizes). The stored answer already held Xcite.
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("blink.com.kw/search/suggest.json")) {
        return new Response(
          JSON.stringify({
            resources: {
              results: {
                products: [
                  { title: TITLE, handle: "dualsense-ps5", price: "22.50", variants: [{ price: "22.50", available: true }] },
                ],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const staged = collectLiveResultsStaged(query, {
      fetchImpl,
      cache,
      snapshots: true,
      country: "KW",
      deadlineMs: 400,
    });
    // The lead replay still paints nothing (REEA-1141): it carries no claim on
    // the live shelf, and the first live stage that paints a card carries the
    // stored answer's rows on that same card.
    expect((await staged.stages[0]).replay).toBe(true);
    let painted: LiveSearchResult | null = null;
    for (const stage of staged.stages) {
      const snap = await stage;
      if (snap.replay !== true && snap.products.length > 0) {
        painted = snap;
        break;
      }
    }
    expect(painted).toBeTruthy();
    const card = painted?.products.find((p) => p.productId === "sony-dualsense-controller-ps5");
    expect(card).toBeTruthy();
    expect(card?.offers.map((o) => o.merchant)).toContain("Xcite");
    expect(card?.offers.find((o) => o.merchant === "Xcite")?.fromSnapshot).toBe(true);
    expect(comparisonMerchantCount(card?.offers ?? [], "KW")).toBe(2);
    // The live row still wins its own listing: no duplicate Blink row.
    expect(card?.offers.filter((o) => o.merchant === "Blink")).toHaveLength(1);
  });
});
