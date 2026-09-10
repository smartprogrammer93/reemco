/**
 * REEA-488 item 2 + metrics — the two aggregation helpers behind the weekly
 * export. They must stay pure and total: sums across snapshots, the fixed
 * COVERAGE_ORDER presentation, and honest nulls for empty windows — never a
 * fabricated 0% or 100% where nothing was observed.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedProduct } from "@/types/product";
import {
  aggregateAlternativesFill,
  aggregateCouponCoverage,
} from "@/lib/collect/coverage";

describe("aggregateCouponCoverage (REEA-488 item 2)", () => {
  it("sums offers and couponed offers per merchant across snapshots", () => {
    const rows = aggregateCouponCoverage([
      [
        { merchant: "Xcite", hits: 4, coupons: 2 },
        { merchant: "Blink", hits: 1 },
      ],
      [{ merchant: "Xcite", hits: 6, coupons: 3 }],
    ]);
    expect(rows).toEqual([
      { merchant: "Xcite", offers: 10, couponOffers: 5, coverage: 0.5 },
      { merchant: "Blink", offers: 1, couponOffers: 0, coverage: 0 },
    ]);
  });

  it("keeps the fixed COVERAGE_ORDER presentation across merges", () => {
    const rows = aggregateCouponCoverage([
      [{ merchant: "Jarir", hits: 2, coupons: 1 }],
      [{ merchant: "Xcite", hits: 1, coupons: 0 }],
    ]);
    expect(rows.map((r) => r.merchant)).toEqual(["Xcite", "Jarir"]);
  });

  it("unknown merchants rank last and an empty window stays null", () => {
    const rows = aggregateCouponCoverage([
      [{ merchant: "Odd Shop", hits: 1, coupons: 1 }],
      [{ merchant: "Xcite", hits: 0 }],
    ]);
    expect(rows.map((r) => r.merchant)).toEqual(["Xcite", "Odd Shop"]);
    expect(rows[0].coverage).toBeNull(); // zero offers observed — no rate invented
    expect(rows[1].coverage).toBe(1);
  });
});

describe("aggregateAlternativesFill (REEA-488 metrics)", () => {
  const p = (n: number): NormalizedProduct => ({
    productId: `p-${n}`,
    title: `Product ${n}`,
    brand: "Brand",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: Array.from({ length: n }, (_, i) => ({
      productId: `alt-${i}`,
      title: `alt-${i}`,
      fromPrice: 10 + i,
    })),
  });

  it("counts served products whose alternatives are non-empty", () => {
    const fill = aggregateAlternativesFill([[p(2), p(0)], [p(1)]]);
    expect(fill).toEqual({ productsSeen: 3, productsWithAlternatives: 2, nonEmptyRate: 2 / 3 });
  });

  it("an empty week reports a null rate, not a fake zero", () => {
    expect(aggregateAlternativesFill([])).toEqual({
      productsSeen: 0,
      productsWithAlternatives: 0,
      nonEmptyRate: null,
    });
  });
});
