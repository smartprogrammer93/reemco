/**
 * REEA-807 — weekly outcome snapshot for the PM.
 *
 * GET /api/metrics/weekly?weeks=<1..26>
 * Returns the retained weekly aggregate counters: searches served, zero-offer
 * searches, per-retailer offer counts, dead-link smoke results (all recorded
 * server-side by this module's store), plus offer link clicks per week
 * aggregated from the anonymous REEA-37 funnel events (a click is only
 * observable client-side; the beacon store is the source for that one
 * metric). No PII: the payload carries integer counters and retailer names
 * only — the funnel aggregation reads event types, never identifiers.
 *
 * Response shape (no-store):
 * { generated_at, retention_weeks, weeks: { "<ISOWeek>": {
 *   searches, zero_offer_searches, offers_by_retailer,
 *   cold_serves_full, cold_serves_pending,
 *   retailer_adapter_attempts, retailer_adapter_failures,
 *   latency_band_lt_1s, latency_band_1_3s, latency_band_3_10s,
 *   latency_band_gt_10s,
 *   offer_link_clicks, link_smoke: { runs, checked, dead, by_retailer } } } }
 *
 * REEA-871 — the cold-serve outcome split, the per-retailer adapter
 * attempts/failures and the four latency bands ride the same payload with
 * the same no-store header and the same 1–26 weeks clamping. Invariants by
 * construction: cold_serves_full + cold_serves_pending == searches, the four
 * bands sum to searches, and retailer_adapter_failures ≤ attempts per
 * retailer. Weeks stored before the extension read back with 0 backfill.
 */
import { RETENTION_WEEKS, isoWeekKey, readWeeklyCounters } from "@/lib/metrics";
import { readEvents } from "@/lib/event-store";
import type { FunnelEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEEKS = RETENTION_WEEKS;

function parseWeeksParam(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 8;
  return Math.min(n, MAX_WEEKS);
}

/** Offer-link clicks per ISO week from the anonymous funnel events. */
export function clicksByWeek(events: FunnelEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "item_clicked") continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const week = isoWeekKey(t);
    out[week] = (out[week] ?? 0) + 1;
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  const windowWeeks = parseWeeksParam(new URL(req.url).searchParams.get("weeks"));
  const [counters, events] = await Promise.all([readWeeklyCounters(), readEvents()]);
  const clicks = clicksByWeek(events);

  const weeks: Record<string, unknown> = {};
  const keys = Object.keys(counters).sort().slice(-windowWeeks);
  for (const week of keys) {
    const w = counters[week];
    weeks[week] = {
      searches: w.searches,
      zero_offer_searches: w.zero_offer_searches,
      offers_by_retailer: w.offers_by_retailer,
      // REEA-871 — aggregate extension (integer counters, retailer names only).
      cold_serves_full: w.cold_serves_full,
      cold_serves_pending: w.cold_serves_pending,
      retailer_adapter_attempts: w.retailer_adapter_attempts,
      retailer_adapter_failures: w.retailer_adapter_failures,
      latency_band_lt_1s: w.latency_band_lt_1s,
      latency_band_1_3s: w.latency_band_1_3s,
      latency_band_3_10s: w.latency_band_3_10s,
      latency_band_gt_10s: w.latency_band_gt_10s,
      offer_link_clicks: clicks[week] ?? 0,
      link_smoke: w.link_smoke,
    };
  }

  return Response.json(
    {
      generated_at: new Date().toISOString(),
      retention_weeks: MAX_WEEKS,
      window_weeks: windowWeeks,
      weeks,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
