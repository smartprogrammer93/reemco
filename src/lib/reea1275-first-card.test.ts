/**
 * REEA-1275 — first-card paint on the served head.
 *
 * Root cause measured on the served head: the exact-model seed card
 * (REEA-1261's last verified observation) was folded into every snapshot but
 * the paint chain withheld it from every intermediate flush (REEA-1238's
 * comparison-only rule), so it could only land at the 1.8 s finalize. The
 * LEAD flush below is the fix: the seed resolves off the shell path and paints
 * as its own first flush, while every live stage still folds it idempotently.
 *
 * These pin the paint policy AND the metrics fold together: the counter must
 * describe the same population the shopper's page painted (REEA-1099/1141).
 */
import { describe, expect, it } from "vitest";
import type { NormalizedProduct } from "@/types/product";
import {
  CATEGORY_SHELF_CARDS,
  freshCardsForFlush,
  paintedIdsAfter,
  paintedShelfCardsAcrossStages,
  trimStagesToPaintedDiff,
} from "@/lib/results-shelf";

type P = NormalizedProduct;

function offer(merchant: string, price: number) {
  return {
    merchant,
    price,
    currency: "KWD" as const,
    url: `https://example.test/${merchant.toLowerCase()}/${price}`,
    inStock: true,
  };
}

function product(productId: string, title: string, offers: ReturnType<typeof offer>[]): P {
  return {
    productId,
    title,
    brand: "Keychron",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
    productScope: "primary",
  };
}

const seed = product("keychron-v3-max", "Keychron V3 Max Wireless Mechanical Keyboard", [
  offer("Xcite", 39.9),
]);
const liveSeed = product("keychron-v3-max", "Keychron V3 Max Wireless Mechanical Keyboard", [
  offer("Xcite", 39.9),
  offer("Jarir", 41.5),
]);
const other = product("keychron-v3-max-iso", "Keychron V3 Max ISO Keyboard", [offer("Blink", 45)]);
const categorySingle = product("headphones-single", "Sony Headphones", [offer("Xcite", 20)]);
const categoryComparison = product("headphones-pair", "Sony Headphones", [
  offer("Xcite", 20),
  offer("Blink", 21),
]);

describe("REEA-1275 — the seed lead paints the exact-model card in the first flush", () => {
  it("paints the seed's single-retailer card on a non-final LEAD flush", () => {
    const fresh = freshCardsForFlush([seed], new Set(), false, 12, {
      comparisonFirst: true,
      finalFlush: false,
      leadFlush: true,
      singleTail: 2,
    });
    expect(fresh.map((p) => p.productId)).toEqual([seed.productId]);
  });

  it("keeps the REEA-1238 comparison-only rule for a normal intermediate flush", () => {
    const fresh = freshCardsForFlush([seed], new Set(), false, 12, {
      comparisonFirst: true,
      finalFlush: false,
      singleTail: 2,
    });
    expect(fresh).toEqual([]);
  });

  it("keeps a category shelf's comparison-only intermediate flush intact", () => {
    const fresh = freshCardsForFlush([categorySingle, categoryComparison], new Set(), false, CATEGORY_SHELF_CARDS, {
      comparisonFirst: true,
      finalFlush: false,
      singleTail: 1,
    });
    expect(fresh.map((p) => p.productId)).toEqual([categoryComparison.productId]);
  });

  it("the metrics fold paints the lead seed, then the live stages supersede it", async () => {
    const stages = [
      Promise.resolve({ products: [seed], notes: [], seedLead: true }),
      Promise.resolve({ products: [liveSeed, other], notes: [] }),
    ];
    const painted = await paintedShelfCardsAcrossStages(stages, "keychron v3 max", 1, null, false);
    // The lead owns the slot; the live stage's merged version of the same
    // productId is not appended twice, and the genuinely new card lands.
    expect(painted.map((p) => p.productId)).toEqual([seed.productId, other.productId]);
    const ids = paintedIdsAfter(new Set(), painted);
    expect(ids.size).toBe(2);
  });

  it("a lead flush cannot paint past the cumulative page budget", () => {
    const fresh = freshCardsForFlush([seed], new Set(["a", "b"]), false, 2, {
      comparisonFirst: true,
      finalFlush: false,
      leadFlush: true,
    });
    expect(fresh).toEqual([]);
  });

  it("an exact-model intermediate flush may paint ONE early single, no more", () => {
    const fresh = freshCardsForFlush([seed, other], new Set(), false, 12, {
      comparisonFirst: true,
      finalFlush: false,
      singleTail: 2,
      earlySingles: 1,
    });
    expect(fresh.map((p) => p.productId)).toEqual([seed.productId]);
  });

  it("the category shelf still withholds singles from an intermediate flush", () => {
    const fresh = freshCardsForFlush([categorySingle], new Set(), false, CATEGORY_SHELF_CARDS, {
      comparisonFirst: true,
      finalFlush: false,
      singleTail: 1,
      earlySingles: 0,
    });
    expect(fresh).toEqual([]);
  });

  it("trimming the streamed stages preserves the painted shelf and the last stage", async () => {
    const full = [
      Promise.resolve({ products: [seed], notes: [], seedLead: true }),
      Promise.resolve({ products: [seed, other], notes: [] }),
      Promise.resolve({ products: [liveSeed, other], notes: [] }),
    ];
    const trimmed = trimStagesToPaintedDiff(full, "keychron v3 max", 1, null, false);
    // Intermediate stages carry only their fresh cards (the lead already owns
    // the seed id) and no notes; the last stage stays full for the converged
    // view and the coverage/stamp boundaries.
    const mid = await trimmed[1];
    expect(mid.products.map((p) => p.productId)).toEqual([other.productId]);
    expect(mid.notes).toEqual([]);
    const last = await trimmed[2];
    expect(last.products.map((p) => p.productId)).toEqual([liveSeed.productId, other.productId]);

    const paintedFull = await paintedShelfCardsAcrossStages(full, "keychron v3 max", 1, null, false);
    const paintedTrimmed = await paintedShelfCardsAcrossStages(trimmed, "keychron v3 max", 1, null, false);
    expect(paintedTrimmed.map((p) => p.productId)).toEqual(paintedFull.map((p) => p.productId));
  });

  it("a replay stage is trimmed to no products (it paints nothing)", async () => {
    const trimmed = trimStagesToPaintedDiff(
      [Promise.resolve({ products: [seed], notes: [], replay: true }), Promise.resolve({ products: [other], notes: [] })],
      "keychron v3 max",
      1,
      null,
      false,
    );
    expect((await trimmed[0]).products).toEqual([]);
  });

  it("page 2+ keeps the full snapshots (the renderer's page slice needs them)", async () => {
    const full = [Promise.resolve({ products: [seed, other], notes: [] }), Promise.resolve({ products: [other], notes: [] })];
    const trimmed = trimStagesToPaintedDiff(full, "keychron v3 max", 2, null, false);
    expect((await trimmed[0]).products.map((p) => p.productId)).toEqual([seed.productId, other.productId]);
  });
});
