/**
 * REEA-1141 AC-4 — the duplicate-card aggregate and the dedupe ratio.
 *
 * The counter must describe the SAME population the served document painted:
 * the streamed shelf's cumulative paint chain (lib/results-shelf.ts), where a
 * cached replay contributes nothing and a card already painted by an earlier
 * flush is never painted again. Post-fix the honest read is 0 duplicates; a
 * non-zero value is the exact inflation to subtract from
 * `comparison_depth.cards_total`. Aggregate integers only — no card ids.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedProduct } from "@/types/product";

process.env.METRICS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-metrics-1141-"));
process.env.EVENTS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-events-1141-"));
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const {
  duplicateCardsOf,
  freshCardsForFlush,
  paintedIdsAfter,
  paintedShelfCardsAcrossStages,
} = await import("@/lib/results-shelf");
const { applySearchOutcome, emptyWeek, isoWeekKey } = await import("@/lib/metrics");
const { weeklyResponse } = await import("@/app/api/metrics/weekly/route");

type P = NormalizedProduct;

function product(productId: string, title: string, stamp: string): P {
  return {
    productId,
    title,
    brand: "Panadol",
    offers: [
      { merchant: "Xcite", price: 5.8, currency: "KWD", url: `https://xcite.example/${productId}`, inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: stamp,
  };
}

const A = product("panadol-pain-relief-tablets-24tablets", "Panadol Pain Relief Tablets 24Tablets", "2026-11-23T23:27:22.000Z");
const B = product("panadol-advance-tablets-1pack", "Panadol Advance Tablets 1Pack", "2026-11-23T23:27:22.000Z");
const STALE_A = { ...A, scrapedAt: "2026-11-23T23:22:22.000Z" };
const STALE_B = { ...B, scrapedAt: "2026-11-23T23:22:22.000Z" };

function snap(products: P[], replay = false) {
  return { products, replay, notes: [], settled: true };
}

describe("streamed paint chain helpers", () => {
  it("a replay flush paints nothing and claims no ids", () => {
    expect(freshCardsForFlush([STALE_A, STALE_B], new Set(), true)).toEqual([]);
    const next = paintedIdsAfter(new Set(), freshCardsForFlush([STALE_A, STALE_B], new Set(), true));
    expect(next.size).toBe(0);
  });

  it("never paints a card an earlier flush already painted", () => {
    const first = freshCardsForFlush([A, B], new Set(), false);
    const painted = paintedIdsAfter(new Set(), first);
    expect(first.map((p) => p.productId)).toEqual([A.productId, B.productId]);
    // Same products again in a later cumulative flush: nothing fresh.
    expect(freshCardsForFlush([A, B], painted, false)).toEqual([]);
  });

  it("counts duplicate cards by productId (aggregate integer only)", () => {
    expect(duplicateCardsOf([A, B])).toBe(0);
    expect(duplicateCardsOf([A, B, A, A])).toBe(2);
  });

  it("paints one card per product across replay + empty + live stages (panadol repro)", async () => {
    const stages = [
      Promise.resolve(snap([STALE_A, STALE_B], true)),
      Promise.resolve(snap([])),
      Promise.resolve(snap([A, B])),
    ];
    const painted = await paintedShelfCardsAcrossStages(stages, "panadol", 1, null, false);
    expect(painted.map((p) => p.productId)).toEqual([A.productId, B.productId]);
    expect(duplicateCardsOf(painted)).toBe(0);
    // The surviving card is the LIVE (newest) version, not the replay's.
    expect(painted[0].scrapedAt).toBe("2026-11-23T23:27:22.000Z");
  });

  it("a rejected stage contributes nothing instead of failing the fold", async () => {
    const stages = [Promise.reject(new Error("hop down")), Promise.resolve(snap([A]))];
    const painted = await paintedShelfCardsAcrossStages(stages, "panadol", 1, null, false);
    expect(painted.map((p) => p.productId)).toEqual([A.productId]);
  });
});

describe("weekly fold exposes the duplicate-card aggregate (AC-4)", () => {
  it("folds duplicateCards into duplicate_cards, clamped per serve", () => {
    const week = isoWeekKey(Date.parse("2026-11-23T23:27:22.000Z"));
    const weeks = applySearchOutcome({}, week, {
      zeroOffers: false,
      offersByRetailer: {},
      comparisonDepth: { cardsTotal: 4, cardsMultiRetailer: 1 },
      duplicateCards: 4,
      serveOutcome: "full",
      serveLatencyMs: 1200,
    });
    expect(weeks[week].duplicate_cards).toBe(4);
    // Hostile payload can never inflate the week.
    const hostile = applySearchOutcome({}, week, {
      zeroOffers: false,
      offersByRetailer: {},
      duplicateCards: Number.NaN,
      serveOutcome: "full",
      serveLatencyMs: 1,
    });
    expect(hostile[week].duplicate_cards).toBe(0);
  });

  it("exposes duplicate_cards and dedupe_ratio under comparison_depth, integers only", async () => {
    const week = "2026-W48";
    const counters = emptyWeek();
    counters.searches = 10;
    counters.comparison_cards_total = 40;
    counters.comparison_cards_multi_retailer = 12;
    counters.duplicate_cards = 5;
    const res = weeklyResponse({ weeks: { [week]: counters }, source: "local", kvReadFailed: false }, {}, 8);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      weeks: Record<string, { comparison_depth: Record<string, number> }>;
    };
    const depth = body.weeks[week].comparison_depth;
    expect(depth.cards_total).toBe(40);
    expect(depth.duplicate_cards).toBe(5);
    // unique ÷ painted = (40 − 5) / 40 — the correction the PM can apply.
    expect(depth.dedupe_ratio).toBeCloseTo(35 / 40);
    // No per-card records, no identifiers: integers + one derived ratio.
    expect(Object.keys(depth).sort()).toEqual([
      "cards_multi_retailer",
      "cards_total",
      "dedupe_ratio",
      "duplicate_cards",
      "ratio",
    ]);
  });

  it("reads a clean week as 0 duplicates and a full dedupe ratio", async () => {
    const week = "2026-W48";
    const counters = emptyWeek();
    counters.comparison_cards_total = 4;
    counters.comparison_cards_multi_retailer = 1;
    const res = weeklyResponse({ weeks: { [week]: counters }, source: "local", kvReadFailed: false }, {}, 8);
    const body = (await res.json()) as {
      weeks: Record<string, { comparison_depth: Record<string, number> }>;
    };
    expect(body.weeks[week].comparison_depth.duplicate_cards).toBe(0);
    expect(body.weeks[week].comparison_depth.dedupe_ratio).toBe(1);
  });
});
