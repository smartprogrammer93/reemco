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
  coverageLine,
  summarizeResponders,
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

describe("summarizeResponders (REEA-1070 AC2: partial-response truth)", () => {
  it("splits answered / answered-empty / no-response in fixed adapter order", () => {
    const responders = summarizeResponders([
      { merchant: "Jarir", hits: 0, error: "timeout" },
      { merchant: "Xcite", hits: 3 },
      { merchant: "Blink", hits: 0 },
      { merchant: "Eureka", hits: 0, error: "HTTP 503" },
    ]);
    expect(responders).toEqual({
      queried: ["Xcite", "Blink", "Eureka", "Jarir"],
      answered: ["Xcite"],
      answeredEmpty: ["Blink"],
      noResponse: ["Eureka", "Jarir"],
    });
  });

  it("agrees with the calm coverage sentence it feeds", () => {
    const notes = [
      { merchant: "Xcite", hits: 2 },
      { merchant: "Blink", hits: 0, error: "timeout" },
      { merchant: "Jarir", hits: 0 },
    ];
    const responders = summarizeResponders(notes);
    const line = coverageLine(notes, "en");
    expect(line).toContain("Prices from Xcite");
    expect(line).toContain("No response from Blink");
    expect(line).not.toContain("Jarir");
    expect(responders.answered).toEqual(["Xcite"]);
    expect(responders.noResponse).toEqual(["Blink"]);
    expect(responders.answeredEmpty).toEqual(["Jarir"]);
  });
});

describe("coverageLine — REEA-1078 AC9: a blocked lane is unreachable, not empty", () => {
  const product = (merchant: string): NormalizedProduct => ({
    productId: `p-${merchant}`,
    title: "Apple iPhone 17 Pro",
    brand: "Apple",
    offers: [{ merchant, price: 389, currency: "KWD", url: "https://x/1", inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
  });

  it("names a blocked lane as unreachable in EN, instead of leaving its zero silent", () => {
    const notes = [
      { merchant: "Xcite", hits: 1 },
      { merchant: "Lulu Hypermarket", hits: 0 },
    ];
    expect(coverageLine(notes, "en", [product("Xcite")], ["Lulu Hypermarket"])).toBe(
      "Unreachable: Lulu Hypermarket. Prices from Xcite.",
    );
  });

  it("speaks Arabic for the same lane, with no status codes or internals", () => {
    const notes = [
      { merchant: "Xcite", hits: 1 },
      { merchant: "Lulu Hypermarket", hits: 0 },
    ];
    const line = coverageLine(notes, "ar", [product("Xcite")], ["Lulu Hypermarket"]);
    expect(line).toBe("تعذّر الوصول إلى Lulu Hypermarket. أسعار من Xcite.");
    expect(line).not.toMatch(/40\d|timeout|abort/i);
  });

  it("does not report the same lane as both unreachable and 'no response'", () => {
    const notes = [
      { merchant: "Xcite", hits: 1 },
      { merchant: "Lulu Hypermarket", hits: 0, error: "HTTP 403" },
    ];
    expect(coverageLine(notes, "en", [product("Xcite")], ["Lulu Hypermarket"])).toBe(
      "Unreachable: Lulu Hypermarket. Prices from Xcite.",
    );
  });

  it("leaves a lane that answered byte-for-byte as today", () => {
    const notes = [
      { merchant: "Xcite", hits: 1 },
      { merchant: "Lulu Hypermarket", hits: 2 },
    ];
    const rendered = [product("Xcite"), product("Lulu Hypermarket")];
    expect(coverageLine(notes, "en", rendered, ["Lulu Hypermarket"])).toBe(
      coverageLine(notes, "en", rendered),
    );
  });

  it("keeps today's sentence when no reachability record is available", () => {
    const notes = [
      { merchant: "Xcite", hits: 1 },
      { merchant: "Blink", hits: 0, error: "timeout" },
    ];
    expect(coverageLine(notes, "en", [product("Xcite")], undefined)).toBe(
      "No response from Blink. Prices from Xcite.",
    );
  });
});
