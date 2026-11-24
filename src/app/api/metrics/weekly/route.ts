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
 *   latency_warm_band_lt_1s, latency_warm_band_1_3s,
 *   latency_warm_band_3_10s, latency_warm_band_gt_10s,
 *   comparison_depth: { cards_total, cards_multi_retailer, ratio },
 *   filtered_empty_searches,
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
 *
 * REEA-1009 S1b — while the bet #2 flag (REEMCO_BET2_FAIL_FAST) is on, the
 * 200 payload gains a `methodology` block stating what the latency bands
 * actually clock (full-convergence recording, 8.5 s structural cap), that
 * p90 is band-interpolated, and the ratified shopper-visible targets
 * (first-offer p75 ≤ 2.0 s; follow-up-complete ≤ 8.5 s). Reporting text
 * only: no counter changes (AC-4).
 *
 * REEA-1078 — measurement integrity (REEA-1074 F4 / AC-A): the payload now
 * carries (a) `comparison_depth` per week — cards_total,
 * cards_multi_retailer and the derived ratio over the served card sets, the
 * core comparison promise that was previously unmeasured — and (b) a warm
 * serve latency band set (`latency_warm_band_*`) disjoint from the cold
 * collection bands (`latency_band_*`). A warm serve is one where a cached
 * live answer led the shopper's first paint (a fresh memo hit, or the
 * stale-while-revalidate repeat that is the normal repeat on the self-hosted
 * box because the completion budget closes before the slowest hops land), so
 * its recorded wall clock is the serve clock; without the split every repeat
 * read as 3–10 s cold. Cold + warm bands sum to searches, and
 * cards_multi_retailer ≤ cards_total by construction. Aggregate integers
 * only — still no per-user, per-query or per-card data.
 *
 * REEA-1099 — measurement integrity for the two counters above:
 *  - `comparison_depth` now folds the RESULTS-PAGE SHELF card population
 *    (the primary slice the page paints, see lib/results-shelf.ts), not every
 *    product the snapshot carries. Related-band rows (chips, not result
 *    cards) and selection-dropped rows no longer count. A week that mixes
 *    serves recorded before this counter shipped still reads a deflated
 *    cards/serve (the numerator starts at the ship; the week's `searches`
 *    includes earlier serves) — read cards/serve only across an all-shipped
 *    window.
 *  - `retailer_adapter_failures` now counts a DISPATCHED lane that returned no
 *    usable payload (Cloudflare 403 / challenge / zone block) as a failure,
 *    the same lane the results page already names unreachable (REEA-1078 AC9).
 *    The plan's failure-share formula stays failures / attempts — no new
 *    bucket, still aggregate-only.
 *
 * REEA-1134 F5 — rate-limit uniformity: this was the last API route with no
 * caller budget. It now takes the REEA-827 shared fixed window (30/min per
 * caller; the REEA-1063 gate placement — before the store reads) and exposes
 * the REEA-837 budget headers on every answer. A denied caller gets the
 * standard 429 body and performs no counter or funnel read; the 200/503
 * payloads are otherwise byte-identical to the pre-gate response.
 */
import { RETENTION_WEEKS, isoWeekKey, linkSmokeRates, readWeeklyCountersDetailed } from "@/lib/metrics";
import type { WeeklyCountersRead } from "@/lib/metrics";
import { readEvents } from "@/lib/event-store";
import type { FunnelEvent } from "@/lib/events";
// REEA-1134 F5 — this read is the last API route without a rate-limit gate;
// it now rides the same REEA-827 shared fixed-window gate as its siblings.
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { rateLimitHeaders } from "@/lib/rate-limit";
// REEA-1009 S1b — the metric-honesty note rides the payload only while the
// bet #2 flag is on (a reporting-text change is part of the §9 flag-gated
// change; flag-off answers the exact pre-bet payload).
import { bet2FailFastEnabled } from "@/lib/collect/bet2-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEEKS = RETENTION_WEEKS;

/**
 * REEA-1134 F5 — per-caller budget for the PM snapshot read (30/min).
 *
 * This endpoint is read by the reporting loop, not by shoppers, so the
 * shopper routes' 120/min would be pure headroom; 30/min still covers a
 * dashboard refreshing every few seconds while bounding a runaway poller.
 * Denials answer before any store read, so a spent caller costs zero KV
 * round trips (REEA-1063's "zero expensive work" gate placement).
 */
export const WEEKLY_METRICS_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

// Same caller key as the sibling gated routes (first X-Forwarded-For hop).
function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

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
  // REEA-1134 F5 — gate ahead of the store reads: a spent caller answers 429
  // without touching the weekly counters or the funnel store.
  const gate = await checkRateLimitShared(
    `metrics-weekly:${clientKey(req)}`,
    Date.now(),
    WEEKLY_METRICS_RATE_LIMIT,
  );
  if (!gate.allowed) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429, headers: rateLimitHeaders(gate) });
  }
  // REEA-837 wire shape: the budget stays observable on the 200/503 answers.
  const gateHeaders = rateLimitHeaders(gate);

  const windowWeeks = parseWeeksParam(new URL(req.url).searchParams.get("weeks"));
  const [read, events] = await Promise.all([readWeeklyCountersDetailed(), readEvents()]);
  const res = weeklyResponse(read, clicksByWeek(events), windowWeeks);
  for (const [name, value] of Object.entries(gateHeaders)) res.headers.set(name, value);
  return res;
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
      // REEA-1078 — warm-serve bands: a fresh memo hit's SERVE clock, kept
      // disjoint from the cold collection bands above. Cold + warm == searches.
      latency_warm_band_lt_1s: w.latency_warm_band_lt_1s,
      latency_warm_band_1_3s: w.latency_warm_band_1_3s,
      latency_warm_band_3_10s: w.latency_warm_band_3_10s,
      latency_warm_band_gt_10s: w.latency_warm_band_gt_10s,
      // REEA-1078 — comparison depth: one aggregate per week, never per query
      // or per card (Data Minimization). ratio is derived, 0 when no cards.
      comparison_depth: {
        cards_total: w.comparison_cards_total,
        cards_multi_retailer: w.comparison_cards_multi_retailer,
        ratio: w.comparison_cards_total > 0 ? w.comparison_cards_multi_retailer / w.comparison_cards_total : 0,
        // REEA-1141 AC-4 — duplicate cards the served streamed shelf painted
        // (same paint chain as the renderer, aggregate integer only) and the
        // derived dedupe ratio (unique cards ÷ painted cards, 1 when clean).
        // A non-zero duplicate_cards is the inflation to subtract from
        // cards_total before reading depth; the ratio states the same fact.
        duplicate_cards: w.duplicate_cards,
        dedupe_ratio:
          w.comparison_cards_total > 0
            ? Math.max(
                0,
                w.comparison_cards_total - Math.min(w.duplicate_cards, w.comparison_cards_total),
              ) / w.comparison_cards_total
            : 1,
      },
      // REEA-1114 AC6 — false-empty numerator: serves whose visible set was
      // zero because an active filter hid matches. Aggregate integer only;
      // the rate is filtered_empty_searches ÷ searches.
      filtered_empty_searches: w.filtered_empty_searches,
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
      // REEA-1009 S1b — metric honesty (bet #2 spec v1.0 §5, AC-6(c)/AC-8):
      // the latency-band clock is the full-convergence recording, p90 is
      // band-interpolated with an 8.5 s structural max, and the budget is
      // stated against the shopper-visible clocks the ratified AC-8 targets
      // use. Pure reporting text — no counter changes, no new instrumentation
      // (AC-4/REEA-865 stand), bands themselves untouched (REEA-884).
      ...(bet2FailFastEnabled()
        ? {
            methodology: {
              latency_band_clock:
                "fan-out start → converged-chain recording (serveLatencyMs in the results after() tail: allSettled + final + converged + adapterTelemetry), structurally capped at RESULTS_COMPLETION_BUDGET_MS (1800 ms) + STAGE_TAIL_HEADROOM_MS (6200 ms) = 8.5 s",
              p90:
                "REEA-884 band-interpolated inside the containing band; the structural max is the 8.5 s tail cap, so the raw within-band p90 never exceeds it — a figure above 8.5 s is interpolation, not a measured tail",
              shopper_visible_targets:
                "first-offer p75 ≤ 2.0 s (G3 guard — staged first-offer flush must not get slower); full-offer follow-up-complete ≤ 8.5 s (the recording cap); blocking aggregate gates: latency_band_gt_10s == 0 and cold_serves_pending < 5% weekly (AC-8, ratified on REEA-1002)",
              source: "REEA-1009 bet #2 spec v1.0 §5 S1b / §10; band definitions unchanged (REEA-871/REEA-884)",
            },
          }
        : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
