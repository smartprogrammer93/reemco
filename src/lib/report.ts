/**
 * REEA-37 — weekly funnel aggregation (AC-4).
 *
 * Pure functions over the event list so the math is unit-testable and
 * shared by GET /api/events/report and scripts/weekly-report.ts.
 *
 * Metric definitions (per REEA-24 / PM spec):
 * - click-out rate  = item_clicked events / search_submitted events
 * - copy-rate = summary_copied events / search_submitted events (REEA-541)
 * - zero-result rate = zero_results events / search_submitted events
 * - top queries = most frequent non-empty search queries in the window
 *
 * REEA-216 §3 add-on (REEA-233): click_rank_histogram buckets item_clicked
 * events by their card rank so position-1 click-out share and mean clicked
 * position are derivable straight from the report payload. Existing fields
 * are unchanged. Rank -1 marks product-detail-page clicks (see
 * ProductResultCard); result-card positions start at 0.
 *
 * REEA-965 — v1 metrics block (R2 spec AC-6/AC-7): the relevance/coupon
 * event stream aggregated over the same window — per-day zero-result rate
 * and first-result CTR, and coupon-hit rate per retailer. Definitions
 * (FR-3.4/FR-3.3):
 * - zero_result_rate = zero_result_shown / search_performed
 * - first_result_ctr = first_result_click / search_performed where
 *   resultCount ≥ 1 (the denominator reads each event's own resultCount)
 * - coupon_hit_rate(retailer) = coupon_hit / offer_rendered per retailer
 * All three are computable from the raw event stream alone; this block is
 * the queryable shape, recomputed per report read from raw events that land
 * immediately — well inside the 24h queryability requirement (v1 sink is
 * the raw JSONL/KV log itself).
 */
import type { FunnelEvent } from "@/lib/events";

export interface RankBucket {
  rank: number;
  count: number;
}

/** REEA-965 — one UTC day of v1 funnel-head metrics (AC-6: queryable per day). */
export interface V1DayMetrics {
  /** UTC calendar day (YYYY-MM-DD) the events landed on. */
  day: string;
  searches: number;
  zero_result_shown: number;
  first_result_clicks: number;
  zero_result_rate: number | null;
  first_result_ctr: number | null;
}

/** REEA-965 — coupon-hit rate per retailer (AC-7, the R4 decision input). */
export interface V1RetailerCouponRate {
  retailer: string;
  offers_rendered: number;
  coupon_hits: number;
  coupon_hit_rate: number | null;
}

export interface V1Report {
  searches: number;
  zero_result_shown: number;
  first_result_clicks: number;
  result_clicks: number;
  related_clicks: number;
  zero_result_rate: number | null;
  first_result_ctr: number | null;
  per_day: V1DayMetrics[];
  coupon_hit_rate_by_retailer: V1RetailerCouponRate[];
}

export interface WeeklyReport {
  window_days: number;
  generated_at: string;
  searches: number;
  click_outs: number;
  click_out_rate: number | null; // null when no searches in window
  copies: number;
  copy_rate: number | null; // REEA-541: summary_copied per search, beside click_out_rate
  zero_results: number;
  zero_result_rate: number | null;
  top_queries: { query: string; count: number }[];
  /** item_clicked counts per card position, ascending by rank (REEA-233). */
  click_rank_histogram: RankBucket[];
  /** REEA-965 — v1 relevance/coupon metrics over the same window. */
  v1: V1Report;
}

export function inWindow(events: FunnelEvent[], now: number, windowDays: number): FunnelEvent[] {
  const cut = now - windowDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cut;
  });
}

/**
 * REEA-965 — aggregate the v1 event stream (pure; unit-testable). Tolerates
 * legacy/hand-written lines missing optional properties by counting only
 * what the schema guarantees, so a corrupt line can never skew a rate.
 */
export function aggregateV1(win: FunnelEvent[]): V1Report {
  let searches = 0;
  let searchesWithResults = 0;
  let zeroResultShown = 0;
  let firstResultClicks = 0;
  let resultClicks = 0;
  let relatedClicks = 0;
  const perDay = new Map<
    string,
    { searches: number; searchesWithResults: number; zero: number; firstClicks: number }
  >();
  const couponByRetailer = new Map<string, { rendered: number; hits: number }>();

  const dayOf = (e: FunnelEvent): string => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "unknown";
  };
  const dayBucket = (day: string) => {
    let b = perDay.get(day);
    if (!b) {
      b = { searches: 0, searchesWithResults: 0, zero: 0, firstClicks: 0 };
      perDay.set(day, b);
    }
    return b;
  };

  for (const e of win) {
    switch (e.type) {
      case "search_performed": {
        searches += 1;
        const withResults = (e.resultCount ?? 0) >= 1;
        if (withResults) searchesWithResults += 1;
        const b = dayBucket(dayOf(e));
        b.searches += 1;
        if (withResults) b.searchesWithResults += 1;
        break;
      }
      case "zero_result_shown": {
        zeroResultShown += 1;
        dayBucket(dayOf(e)).zero += 1;
        break;
      }
      case "first_result_click": {
        firstResultClicks += 1;
        dayBucket(dayOf(e)).firstClicks += 1;
        break;
      }
      case "result_click":
        resultClicks += 1;
        break;
      case "related_click":
        relatedClicks += 1;
        break;
      case "offer_rendered": {
        const retailer = e.retailer ?? "unknown";
        let r = couponByRetailer.get(retailer);
        if (!r) {
          r = { rendered: 0, hits: 0 };
          couponByRetailer.set(retailer, r);
        }
        r.rendered += 1;
        break;
      }
      case "coupon_hit": {
        const retailer = e.retailer ?? "unknown";
        let r = couponByRetailer.get(retailer);
        if (!r) {
          r = { rendered: 0, hits: 0 };
          couponByRetailer.set(retailer, r);
        }
        r.hits += 1;
        break;
      }
      default:
        break;
    }
  }

  const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

  const days: V1DayMetrics[] = [...perDay.entries()]
    .map(([day, b]) => ({
      day,
      searches: b.searches,
      zero_result_shown: b.zero,
      first_result_clicks: b.firstClicks,
      zero_result_rate: rate(b.zero, b.searches),
      first_result_ctr: rate(b.firstClicks, b.searchesWithResults),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const couponRates: V1RetailerCouponRate[] = [...couponByRetailer.entries()]
    .map(([retailer, r]) => ({
      retailer,
      offers_rendered: r.rendered,
      coupon_hits: r.hits,
      coupon_hit_rate: rate(r.hits, r.rendered),
    }))
    .sort((a, b) => b.offers_rendered - a.offers_rendered || a.retailer.localeCompare(b.retailer));

  return {
    searches,
    zero_result_shown: zeroResultShown,
    first_result_clicks: firstResultClicks,
    result_clicks: resultClicks,
    related_clicks: relatedClicks,
    zero_result_rate: rate(zeroResultShown, searches),
    first_result_ctr: rate(firstResultClicks, searchesWithResults),
    per_day: days,
    coupon_hit_rate_by_retailer: couponRates,
  };
}

export function aggregateWeekly(
  events: FunnelEvent[],
  opts: { now?: number; windowDays?: number; topN?: number } = {},
): WeeklyReport {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 7;
  const topN = opts.topN ?? 10;
  const win = inWindow(events, now, windowDays);

  let searches = 0;
  let clickOuts = 0;
  let copies = 0;
  let zeroResults = 0;
  const queryCounts = new Map<string, number>();
  const rankCounts = new Map<number, number>();

  for (const e of win) {
    if (e.type === "search_submitted") {
      searches += 1;
      if (e.query) {
        queryCounts.set(e.query, (queryCounts.get(e.query) ?? 0) + 1);
      }
    } else if (e.type === "zero_results") {
      zeroResults += 1;
    } else if (e.type === "summary_copied") {
      copies += 1;
    } else if (e.type === "item_clicked") {
      clickOuts += 1;
      // Schema guarantees rank on item_clicked; guard anyway so hand-written
      // legacy lines without one still count toward click_outs (unchanged
      // meaning), just without a histogram bucket.
      if (typeof e.rank === "number" && Number.isFinite(e.rank)) {
        const rank = Math.trunc(e.rank);
        rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
      }
    }
  }

  const histogram: RankBucket[] = [...rankCounts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => a.rank - b.rank);

  const topQueries = [...queryCounts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query))
    .slice(0, topN);

  return {
    window_days: windowDays,
    generated_at: new Date(now).toISOString(),
    searches,
    click_outs: clickOuts,
    click_out_rate: searches > 0 ? clickOuts / searches : null,
    copies,
    copy_rate: searches > 0 ? copies / searches : null,
    zero_results: zeroResults,
    zero_result_rate: searches > 0 ? Math.min(1, zeroResults / searches) : null,
    top_queries: topQueries,
    click_rank_histogram: histogram,
    v1: aggregateV1(win),
  };
}
