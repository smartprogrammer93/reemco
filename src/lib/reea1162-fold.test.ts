/**
 * REEA-1162 — the late-answer fold must judge richness on OFFER evidence, not
 * on card count.
 *
 * Live defect (REEA-1118 on d9f31b54): the base PS5 DualSense card appeared in
 * only 3/6 collections. The finalized shelf painted Eureka's colourway
 * listings as separate single-offer cards; the converged answer then merged
 * them into ONE card carrying every offer. The follow-up fold compared
 * `products.length`, so the merged answer (fewer cards) was rejected and the
 * stale forked shelf stayed — non-deterministically, depending on how many
 * cards the finalized snapshot had painted.
 */
import { describe, expect, it } from "vitest";
import { preferRicherSnapshot, snapshotOfferTotal } from "@/lib/results-shelf";
import type { NormalizedProduct } from "@/types/product";

function product(
  productId: string,
  title: string,
  offers: Array<{ merchant: string; price: number }>,
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers: offers.map((o, i) => ({
      merchant: o.merchant,
      price: o.price,
      currency: "KWD",
      url: `https://${o.merchant.toLowerCase().replace(/\s+/g, "")}.example/${productId}-${i}`,
      inStock: true,
      collectedAt: "2026-11-24T16:00:00.000Z",
    })),
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-24T16:00:00.000Z",
  };
}

/** The failing live shape: six forked colour/edition cards, one offer each. */
function forkedShelf(): { products: NormalizedProduct[] } {
  const colours = ["Graphite Grey", "Flare Orange", "Emerald", "Lisa", "GTA VI", "Wolverine"];
  return {
    products: colours.map((c, i) =>
      product(`sony-dualsense-ps5-controller-${i}`, `Sony DualSense PS5 Controller ${c}`, [
        { merchant: "Eureka", price: 30.5 },
      ]),
    ),
  };
}

/** The converged answer: ONE merged controller card carrying every offer. */
function mergedShelf(): { products: NormalizedProduct[] } {
  return {
    products: [
      product("sony-dualsense-controller-ps5", "Sony PS5 DualSense Wireless Controller", [
        { merchant: "Wibi", price: 20.9 },
        { merchant: "Blink", price: 25.9 },
        { merchant: "Astore", price: 28.9 },
        { merchant: "Astore", price: 28.9 },
        { merchant: "Eureka", price: 30.25 },
        { merchant: "Eureka", price: 30.25 },
        { merchant: "Eureka", price: 30.5 },
        { merchant: "Eureka", price: 30.5 },
        { merchant: "Eureka", price: 30.5 },
        { merchant: "Eureka", price: 30.5 },
      ]),
    ],
  };
}

describe("REEA-1162 — late-answer fold richness", () => {
  it("replaces the stale forked shelf with the merged answer (fewer cards, more offers)", () => {
    const stale = forkedShelf();
    const merged = mergedShelf();
    expect(stale.products.length).toBeGreaterThan(merged.products.length);
    expect(snapshotOfferTotal(merged.products)).toBeGreaterThan(snapshotOfferTotal(stale.products));
    // The old products.length guard rejected this; the offer-evidence guard
    // must accept it — that is the 3/6 non-determinism.
    expect(preferRicherSnapshot(stale, merged)).toBe(merged);
  });

  it("keeps the rendered shelf when the late answer is poorer", () => {
    const rendered = mergedShelf();
    const poorer = forkedShelf();
    expect(preferRicherSnapshot(rendered, poorer)).toBe(rendered);
  });

  it("accepts an equally rich answer that is strictly more merged (fewer cards)", () => {
    // Same offer evidence (2 rows), but the late answer folded two forked
    // single-offer cards into one card carrying both — strictly fewer cards.
    const rendered = {
      products: [
        product("a", "A", [{ merchant: "Xcite", price: 1 }]),
        product("b", "B", [{ merchant: "Blink", price: 2 }]),
      ],
    };
    const merged = {
      products: [
        product("a", "A", [
          { merchant: "Xcite", price: 1 },
          { merchant: "Blink", price: 2 },
        ]),
      ],
    };
    expect(snapshotOfferTotal(rendered.products)).toBe(snapshotOfferTotal(merged.products));
    expect(preferRicherSnapshot(rendered, merged)).toBe(merged);
  });

  it("REEA-1154 D4 — an exact evidence tie keeps the rendered shelf", () => {
    // Two spellings of one dispatched query must not swap each other's set: a
    // sibling run can carry the same card/offer totals with one different
    // listing (the QA `fold7` vs `فولد 7` Amazon case).
    const rendered = {
      products: [
        product("a", "Samsung Galaxy Z Fold7, 5G, 12 GB RAM", [{ merchant: "Xcite", price: 379.9 }]),
      ],
    };
    const tie = {
      products: [
        product("other", "Uniq MagSafe Case for Galaxy Z Fold 7", [{ merchant: "Wibi", price: 4.05 }]),
      ],
    };
    expect(snapshotOfferTotal(rendered.products)).toBe(snapshotOfferTotal(tie.products));
    expect(preferRicherSnapshot(rendered, tie)).toBe(rendered);
  });

  it("ignores an absent or malformed late answer", () => {
    const rendered = mergedShelf();
    expect(preferRicherSnapshot(rendered, null)).toBe(rendered);
    expect(preferRicherSnapshot(rendered, { products: [] })).toBe(rendered);
    expect(preferRicherSnapshot(rendered, { products: undefined as unknown as [] })).toBe(rendered);
    expect(preferRicherSnapshot(null, mergedShelf())).toEqual(mergedShelf());
  });
});
