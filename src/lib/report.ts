/**
 * REEA-37 — weekly funnel aggregation (AC-4).
 *
 * Pure functions over the event list so the math is unit-testable and
 * shared by GET /api/events/report and scripts/weekly-report.ts.
 *
 * Metric definitions (per REEA-24 / PM spec):
 * - click-out rate  = item_clicked events / search_submitted events
 * - zero-result rate = zero_results events / search_submitted events
 * - top queries = most frequent non-empty search queries in the window
 *
 * REEA-216 §3 add-on (REEA-233): click_rank_histogram buckets item_clicked
 * events by their card rank so position-1 click-out share and mean clicked
 * position are derivable straight from the report payload. Existing fields
 * are unchanged. Rank -1 marks product-detail-page clicks (see
 * ProductResultCard); result-card positions start at 0.
 */
import type { FunnelEvent } from "@/lib/events";

export interface RankBucket {
  rank: number;
  count: number;
}

export interface WeeklyReport {
  window_days: number;
  generated_at: string;
  searches: number;
  click_outs: number;
  click_out_rate: number | null; // null when no searches in window
  zero_results: number;
  zero_result_rate: number | null;
  top_queries: { query: string; count: number }[];
  /** item_clicked counts per card position, ascending by rank (REEA-233). */
  click_rank_histogram: RankBucket[];
}

export function inWindow(events: FunnelEvent[], now: number, windowDays: number): FunnelEvent[] {
  const cut = now - windowDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cut;
  });
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
    zero_results: zeroResults,
    zero_result_rate: searches > 0 ? Math.min(1, zeroResults / searches) : null,
    top_queries: topQueries,
    click_rank_histogram: histogram,
  };
}
