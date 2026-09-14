/**
 * REEA-963 R1 — unit pins for the query-time price-sanity cohort pass.
 * Spec: REEA-961 §document-spec-r1-price-sanity. Each pin names the AC or
 * edge case it proves (AC-5, AC-6, AC-7, E1, E3, E4, E5, E6, E8).
 * No fixture here ships to users: these are test-tooling payloads only
 * (company data policy — everything the module reads arrives per call).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTLIER_RATIO,
  SANITY_MIN_COHORT,
  computeCohortSanity,
  currencyMisMap,
  kwdSanityValue,
  medianOf,
  sanityOutlierRatio,
  type SanityInputHit,
} from "@/lib/collect/price-sanity";

type TestHit = SanityInputHit & { title: string; inStock: boolean };

function hit(over: Partial<TestHit>): TestHit {
  return {
    title: "Samsung Galaxy S26 Ultra 256GB",
    merchant: "Xcite",
    price: 300,
    currency: "KWD",
    url: "https://www.xcite.com/s26/p",
    inStock: true,
    ...over,
  };
}

/** A cohort of six same-device offers around KD 300 — outlier checks run. */
function cohort(): TestHit[] {
  return [
    hit({ url: "https://www.xcite.com/a/p", price: 290 }),
    hit({ url: "https://www.xcite.com/b/p", price: 300 }),
    hit({ url: "https://www.xcite.com/c/p", price: 310 }),
    hit({ url: "https://www.xcite.com/d/p", price: 310 }),
    hit({ url: "https://www.xcite.com/e/p", price: 320, merchant: "Eureka" }),
    hit({ url: "https://www.xcite.com/f/p", price: 305, merchant: "Blink" }),
  ];
}

describe("REEA-963 price-sanity configuration (FR-1.2, AC-6)", () => {
  it("defaults the bound to 15", () => {
    expect(sanityOutlierRatio({})).toBe(DEFAULT_OUTLIER_RATIO);
    expect(DEFAULT_OUTLIER_RATIO).toBe(15);
  });

  it("reads PRICE_SANITY_OUTLIER_RATIO — a 3× bound flips previously-ok offers to flagged (AC-6)", () => {
    expect(sanityOutlierRatio({ PRICE_SANITY_OUTLIER_RATIO: "3" })).toBe(3);
    const hits = cohort();
    const strict = computeCohortSanity("q", hits, { ratio: 3 });
    const loose = computeCohortSanity("q", hits);
    // 320 vs median 302.5 is 1.06× — ok at 15×, still ok at 3×; prove the
    // config path with a genuinely spread cohort instead: 900 (3× of 302.5)
    // flags under the 3× bound and not under 15×.
    const spread = [...hits, hit({ url: "https://www.xcite.com/f9/p", price: 1000 })];
    const strictSpread = computeCohortSanity("q", spread, { ratio: 3 });
    const looseSpread = computeCohortSanity("q", spread);
    expect(strictSpread.byOffer.get(spread[spread.length - 1])?.reason).toBe("outlier_high");
    expect(looseSpread.byOffer.get(spread[spread.length - 1])?.status).toBe("ok");
    void strict;
    void loose;
  });

  it("falls back to the default on garbage env values — the knob never breaks the pass", () => {
    expect(sanityOutlierRatio({ PRICE_SANITY_OUTLIER_RATIO: "abc" })).toBe(15);
    expect(sanityOutlierRatio({ PRICE_SANITY_OUTLIER_RATIO: "0.5" })).toBe(15);
    expect(sanityOutlierRatio({ PRICE_SANITY_OUTLIER_RATIO: "1" })).toBe(15);
  });
});

describe("REEA-963 KWD-space sanity value (E3, E4)", () => {
  it("zero and non-finite prices are not priceable (E3)", () => {
    expect(kwdSanityValue(0, "KWD")).toBeNull();
    expect(kwdSanityValue(-5, "KWD")).toBeNull();
    expect(kwdSanityValue(NaN, "KWD")).toBeNull();
    expect(kwdSanityValue(Infinity, "KWD")).toBeNull();
  });

  it("a currency missing from the conversion table fails to convert (E4)", () => {
    expect(kwdSanityValue(90, "XYZ")).toBeNull();
    expect(kwdSanityValue(90, "SAR")).toBeCloseTo(7.344, 3);
    expect(kwdSanityValue(90, "KWD")).toBe(90);
  });
});

describe("REEA-963 currency mis-map detection (AC-5)", () => {
  it("flags a KWD label on an .eg host — the production EGP-mis-map shape", () => {
    expect(currencyMisMap("https://www.amazon.eg/dp/B123", "KWD")).toBe(true);
  });

  it("never flags honest cross-border shapes", () => {
    expect(currencyMisMap("https://www.amazon.eg/dp/B123", "EGP")).toBe(false);
    expect(currencyMisMap("https://www.xcite.com/s26/p", "KWD")).toBe(false);
    expect(currencyMisMap("https://www.eureka.com.kw/p/1", "KWD")).toBe(false);
    // no host evidence → no opinion (jarir.com sells SAR honestly)
    expect(currencyMisMap("https://www.jarir.com/p/s26", "SAR")).toBe(false);
    expect(currencyMisMap("https://www.sultan-center.com/p/1", "KWD")).toBe(false);
    // .sa host carrying SAR stays clean (danube.sa shape)
    expect(currencyMisMap("https://danube.sa/en/x", "SAR")).toBe(false);
  });
});

describe("REEA-963 outlier bound (FR-1.1, E1, E6, E8)", () => {
  it("flags >15× as outlier_high and keeps the offer's ratio", () => {
    const hits = [...cohort(), hit({ url: "https://www.xcite.com/big/p", price: 40 * 302.5, merchant: "Blink" })];
    const { byOffer } = computeCohortSanity("q", hits);
    const big = hits[hits.length - 1];
    expect(byOffer.get(big)).toMatchObject({ status: "flagged", reason: "outlier_high" });
    expect(byOffer.get(big)?.ratioToMedian).toBeGreaterThan(15);
  });

  it("flags <1/15× as outlier_low (AC-1 accessory-peer shape)", () => {
    const hits = [...cohort(), hit({ url: "https://www.xcite.com/case/p", price: 4, merchant: "Blink" })];
    const { byOffer } = computeCohortSanity("q", hits);
    expect(byOffer.get(hits[hits.length - 1])).toMatchObject({ status: "flagged", reason: "outlier_low" });
  });

  it("boundary is inclusive-by-exclusion: exactly 15.0× and exactly 1/15× do NOT flag (E6)", () => {
    // Median of [100,200,300,400,500,600] = 350. 15× = 5250 exactly; 1/15×
    // of 350 = 23.333… — use a median-exact pair instead: 6 values with
    // median 300, probe at 4500 (15×) and 20 (1/15×).
    const hits = [
      hit({ url: "https://www.xcite.com/a/p", price: 100 }),
      hit({ url: "https://www.xcite.com/b/p", price: 200 }),
      hit({ url: "https://www.xcite.com/c/p", price: 300 }),
      hit({ url: "https://www.xcite.com/d/p", price: 300 }),
      hit({ url: "https://www.xcite.com/e/p", price: 400 }),
      hit({ url: "https://www.xcite.com/f/p", price: 500 }),
    ];
    const exactHigh = hit({ url: "https://www.xcite.com/hi/p", price: 4500, merchant: "Blink" }); // 15×300
    const exactLow = hit({ url: "https://www.xcite.com/lo/p", price: 20, merchant: "Blink" }); // 1/15×300
    const { byOffer } = computeCohortSanity("q", [...hits, exactHigh, exactLow]);
    expect(byOffer.get(exactHigh)).toMatchObject({ status: "ok" });
    expect(byOffer.get(exactLow)).toMatchObject({ status: "ok" });
    const justOver = hit({ url: "https://www.xcite.com/hi2/p", price: 4501, merchant: "Blink" });
    const justUnder = hit({ url: "https://www.xcite.com/lo2/p", price: 19.9, merchant: "Blink" });
    const { byOffer: b2 } = computeCohortSanity("q", [...hits, justOver, justUnder]);
    expect(b2.get(justOver)?.reason).toBe("outlier_high");
    expect(b2.get(justUnder)?.reason).toBe("outlier_low");
  });

  it("skips the check on a tiny cohort and flags nothing (FR-1.5, E1)", () => {
    expect(SANITY_MIN_COHORT).toBe(5);
    const hits = cohort().slice(0, 3);
    const { byOffer, summary } = computeCohortSanity("q", hits);
    expect(summary.outlierCheckSkipped).toBe(true);
    expect(summary.priceableOffers).toBe(3);
    for (const h of hits) expect(byOffer.get(h)?.status).toBe("ok");
  });

  it("computes the median in KWD space over converted offers only (E8)", () => {
    // 300 KWD + 5 × SAR ~36.79 (=3 KWD each)… keep it simple: one KWD 300
    // cohort member and five SAR offers at 3673.53 each (≈300 KWD) — the
    // median must read KWD-space (~300), not raw numerics (~300 vs 3673).
    const sar = (url: string): TestHit =>
      hit({ url, merchant: "Jarir", currency: "SAR", price: 3673 });
    const hits = [
      hit({ url: "https://www.xcite.com/a/p", price: 300 }),
      sar("https://www.jarir.com/a"),
      sar("https://www.jarir.com/b"),
      sar("https://www.jarir.com/c"),
      sar("https://www.jarir.com/d"),
      sar("https://www.jarir.com/e"),
    ];
    const { summary } = computeCohortSanity("q", hits);
    expect(summary.medianKwd).not.toBeNull();
    expect(summary.medianKwd as number).toBeGreaterThan(250);
    expect(summary.medianKwd as number).toBeLessThan(310);
  });
});

describe("REEA-963 one price per offer per render (FR-2.3, E5)", () => {
  it("dedupes a (retailer, SKU) twin to the freshest fetch and logs the divergence", () => {
    const stale = hit({ url: "https://www.xcite.com/a/p", price: 300, collectedAt: "2026-09-14T09:00:00Z" });
    const fresh = hit({ url: "https://www.xcite.com/a/p", price: 320, collectedAt: "2026-09-14T10:00:00Z" });
    const { deduped, summary, byOffer } = computeCohortSanity("q", [stale, fresh, ...cohort().slice(1)]);
    expect(deduped).toHaveLength(cohort().length);
    expect(deduped).toContain(fresh);
    expect(deduped).not.toContain(stale);
    expect(summary.priceDivergences).toBe(1);
    expect(byOffer.get(fresh)?.status).toBe("ok");
  });

  it("equal-price twins dedupe silently (no divergence logged)", () => {
    const a = hit({ url: "https://www.xcite.com/a/p", price: 300, collectedAt: "2026-09-14T09:00:00Z" });
    const b = hit({ url: "https://www.xcite.com/a/p", price: 300, collectedAt: "2026-09-14T10:00:00Z" });
    const { deduped, summary } = computeCohortSanity("q", [a, b]);
    expect(deduped).toHaveLength(1);
    expect(summary.priceDivergences).toBe(0);
  });

  it("URL noise (query string, trailing slash, host case) is one SKU", () => {
    const a = hit({ url: "https://www.xcite.com/a/p?variant=x" });
    const b = hit({ url: "https://WWW.XCITE.com/a/p/", collectedAt: "2026-09-14T10:00:00Z" });
    const { deduped } = computeCohortSanity("q", [a, b]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toBe(b); // fresher wins
  });
});

describe("REEA-963 per-render summary (AC-7)", () => {
  it("carries query id, per-adapter counts, flagged counts by reason, and the median", () => {
    const hits = [
      ...cohort(),
      hit({ url: "https://www.xcite.com/big/p", price: 9000, merchant: "Blink" }),
      hit({ url: "https://www.xcite.com/zero/p", price: 0, merchant: "Eureka" }),
    ];
    const { summary } = computeCohortSanity("iPhone 17 Pro", hits);
    expect(summary.queryId).toBe("iPhone 17 Pro");
    expect(summary.cohortOffers).toBe(8);
    expect(summary.perAdapter["Xcite"]).toEqual({ offers: 4, flagged: 0 });
    expect(summary.perAdapter["Blink"]).toEqual({ offers: 2, flagged: 1 });
    expect(summary.perAdapter["Eureka"]).toEqual({ offers: 2, flagged: 1 });
    expect(summary.flaggedByReason.outlier_high).toBe(1);
    expect(summary.flaggedByReason.price_unavailable).toBe(1);
    expect(summary.outlierCheckSkipped).toBe(false);
    expect(summary.medianKwd).toBeCloseTo(310, 1); // sorted priceable: 290..320 + 9000
  });

  it("medians split odd and even cohorts through one helper", () => {
    expect(medianOf([1, 2, 3])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBe(0);
  });
});
