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
 *   offer_link_clicks,
 *   link_smoke: { runs, checked, ok, dead, challenge, by_retailer,
 *                 dead_rate, challenge_rate,
 *                 checkerContaminated?, methodologyNote? } } } }
 *
 * REEA-871 — the cold-serve outcome split, the per-retailer adapter
 * attempts/failures and the four latency bands ride the same payload with
 * the same no-store header and the same 1–26 weeks clamping. Invariants by
 * construction: cold_serves_full + cold_serves_pending == searches, the four
 * bands sum to searches, and retailer_adapter_failures ≤ attempts per
 * retailer. Weeks stored before the extension read back with 0 backfill.
 *
 * REEA-935 — link_smoke gains the per-outcome counts (ok/dead/challenge) and
 * the derived rates: dead_rate = dead / (ok + dead) — persistent challenges
 * excluded from the denominator — and challenge_rate = challenge / checked
 * (an unknown is surfaced, never dropped). Legacy weeks backfill ok to
 * checked - dead, so a pre-fix week's dead rate reads exactly as recorded.
 * The W37 methodology annotation (checkerContaminated + methodologyNote)
 * rides the same record verbatim.
 *
 * REEA-996 — the intermittent `weeks: {}` was never an honest "no data": a
 * failed shared-KV read (unreachable / error envelope / unparseable blob)
 * collapsed into the same null as a missing key and degraded to the
 * per-instance local layer, empty on a cold lambda, and answered 200 with
 * an empty map the PM loop files as no data (a threshold verdict flips on
 * bad evidence — the REEA-862 rule this endpoint feeds). Now the read is
 * classified: when a KV store is bound but the read FAILED and no local
 * data exists, the route answers 503 with a Retry-After so the reader
 * re-reads instead of misfiling; a genuinely empty store (KV reachable,
 * key absent) still answers 200 with an empty map. The 200 payload shape,
 * the aggregation and the 1–26 window clamping are untouched.
 */
import { RETENTION_WEEKS, isoWeekKey, linkSmokeRates, readWeeklyCountersDetailed } from "@/lib/metrics";
import type { WeeklyCountersRead } from "@/lib/metrics";
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
  const [read, events] = await Promise.all([readWeeklyCountersDetailed(), readEvents()]);
  return weeklyResponse(read, clicksByWeek(events), windowWeeks);
}

/**
 * REEA-996 — pure response builder, exported so the empty-read guard is
 * pinnable without a KV-bound runtime: a failed store read with no local
 * fallback data must fail loudly (503 + Retry-After), never silently
 * answer an empty map.
 */
export function weeklyResponse(
  read: WeeklyCountersRead,
  clicks: Record<string, number>,
  windowWeeks: number,
): Response {
  const weeks: Record<string, unknown> = {};
  const keys = Object.keys(read.weeks).sort().slice(-windowWeeks);
  for (const week of keys) {
    const w = read.weeks[week];
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
      // REEA-935 — per-outcome counts plus the derived dead/challenge rates;
      // the annotation fields ride verbatim when stamped.
      link_smoke: { ...w.link_smoke, ...linkSmokeRates(w.link_smoke) },
    };
  }

  const generated_at = new Date().toISOString();
  if (Object.keys(weeks).length === 0 && read.kvReadFailed) {
    // The store could not be read and nothing local contradicts an empty
    // answer — this is "unknown", not "no data". Fail loudly (non-200) so a
    // threshold verdict is never flipped by bad evidence.
    return Response.json(
      {
        error: "weekly_metrics_store_unreachable",
        generated_at,
        retention_weeks: MAX_WEEKS,
        window_weeks: windowWeeks,
      },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
    );
  }

  return Response.json(
    {
      generated_at,
      retention_weeks: MAX_WEEKS,
      window_weeks: windowWeeks,
      weeks,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
