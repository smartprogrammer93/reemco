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
 *   serves_full, serves_pending,
 *   retailer_adapter_attempts, retailer_adapter_failures,
 *   latency_band_lt_1s, latency_band_1_3s, latency_band_3_10s,
 *   latency_band_gt_10s, latency_p90_ms,
 *   latency_warm_band_lt_1s, latency_warm_band_1_3s,
 *   latency_warm_band_3_10s, latency_warm_band_gt_10s,
 *   comparison_depth: { cards_total, cards_multi_retailer, ratio },
 *   filtered_empty_searches,
 *   offer_link_clicks,
 *   shopper_serves, ctr_denominator_shopper, offer_link_ctr_shopper,
 *   link_smoke: { runs, checked, ok, dead, challenge, by_retailer,
 *                 dead_rate, challenge_rate,
 *                 checkerContaminated?, methodologyNote? } } },
 *   methodology: { latency_band_clock, p90, shopper_visible_targets,
 *                  counter_naming, ctr_denominators, ctr_shopper, source } }
 *
 * REEA-1237 — the offer-link CTR is published on the SHOPPER basis:
 * `shopper_serves` / `ctr_denominator_shopper` are the client page-view
 * beacon count (serves a shopper's browser executed), and
 * `offer_link_ctr_shopper` is `offer_link_clicks ÷ ctr_denominator_shopper`.
 * Numerator and denominator now share one basis (client beacons), one store
 * and one retention window; the server-side ctr_denominator_raw / _clean stay
 * published for continuity. `methodology.ctr_shopper` names both bases and
 * the null-when-no-basis rule. Aggregate integers only, no new identifier.
 *
 * REEA-871/REEA-1148 — the all-serve outcome split (published as
 * serves_full / serves_pending, see the REEA-1148 note below), the
 * per-retailer adapter attempts/failures and the four latency bands ride the
 * same payload with the same no-store header and the same 1–26 weeks
 * clamping. Invariants by construction: serves_full + serves_pending ==
 * searches == sum(cold bands) + sum(warm bands), and
 * retailer_adapter_failures ≤ attempts per retailer. Weeks stored before the
 * extension read back with 0 backfill.
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
 * REEA-1009 S1b / REEA-1148 — the 200 payload ALWAYS carries a
 * `methodology` block stating what the latency bands actually clock
 * (full-convergence recording, 8.5 s structural cap, now enforced by the
 * results after() tail), that p90 is band-interpolated, and the ratified
 * shopper-visible targets (first-offer p75 ≤ 2.0 s; follow-up-complete
 * ≤ 8.5 s). REEA-1148 removed the bet-flag gate: the W49 read found no
 * methodology on the served stamp because the flag was off, so AC-6c (the
 * payload states its own clock) was not on the wire. Reporting text only:
 * no counter changes (AC-4).
 *
 * REEA-1148 — measurement honesty + counter reconciliation (bet #2 REVISE):
 *  - AC-2 choice: RENAMED, not redefined. The all-serve outcome split is
 *    published as `serves_full` / `serves_pending`; the old
 *    `cold_serves_*` names wrongly implied cold-only while the stored
 *    counter also folded warm serves (W48 read: 4,696 "cold full" against a
 *    3,563 cold band sum). Cold and warm stay separable through the disjoint
 *    latency band sets, and `serves_full + serves_pending == searches ==
 *    sum(cold bands) + sum(warm bands)` holds for every week, including the
 *    weeks recorded before this change (the stored value was always the
 *    all-serve split). The `methodology.counter_naming` text states this on
 *    the payload.
 *  - `latency_p90_ms` is a DERIVED per-week field (not a stored counter): the
 *    REEA-884 interpolation with the 3–10 s band's upper edge set to the
 *    recording cap, so the reported p90 cannot claim a tail past 8.5 s.
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
import { RETENTION_WEEKS, coldBandP90Ms, isoWeekKey, linkSmokeRates, readWeeklyCountersDetailed } from "@/lib/metrics";
import type { WeeklyCountersRead } from "@/lib/metrics";
import { readEvents } from "@/lib/event-store";
import type { FunnelEvent } from "@/lib/events";
// REEA-1134 F5 — this read is the last API route without a rate-limit gate;
// it now rides the same REEA-827 shared fixed-window gate as its siblings.
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { rateLimitHeaders } from "@/lib/rate-limit";
// REEA-1148 — the metric-honesty block is no longer bet-flag-gated: the W49
// read found no `methodology` on the served stamp because the flag was off,
// and AC-6c is about the payload always stating its clock. Reporting text
// only — no counter changes (AC-1).

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

/**
 * REEA-1237 — the UTC day the client page-view beacon first shipped
 * (commit e298a9e, deployed 2026-11-27). The shopper CTR is a ratio of two
 * counters that must cover the SAME period: a week whose Monday is before
 * this day pairs a full-week click numerator with a partial-week view
 * denominator, which would overstate the rate (W48 read 5 clicks ÷ 1
 * post-ship view = 500%). So `offer_link_ctr_shopper` is null for such a
 * week — never a number on a mismatched basis — and becomes computable from
 * the first week that starts on/after this day. `shopper_serves` is still
 * published for the partial week, because the count itself is real.
 *
 * This is a one-time build fact, not a setting: it must not move when the
 * box redeploys the same commit.
 */
export const PAGE_VIEW_BEACON_SHIPPED_AT_MS = Date.UTC(2026, 10, 27);

/** Monday 00:00 UTC of an ISO week key ("2026-W48"), or null if unparseable. */
export function isoWeekStartMs(week: string): number | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const wk = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay(); // 0=Sun .. 6=Sat
  const mondayShift = (jan4Day + 6) % 7; // Mon=0
  const week1Mon = jan4 - mondayShift * 24 * 60 * 60 * 1000;
  return week1Mon + (wk - 1) * 7 * 24 * 60 * 60 * 1000;
}

/**
 * REEA-1237 — true only when every serve in the week could have fired the
 * page-view beacon, i.e. the week began on/after the ship day. A partial
 * basis must not be divided into a full-week numerator.
 */
export function shopperBasisCompleteForWeek(week: string): boolean {
  const start = isoWeekStartMs(week);
  return start !== null && start >= PAGE_VIEW_BEACON_SHIPPED_AT_MS;
}

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

/** Count anonymous events of one type per ISO week. */
export function countByWeek(events: FunnelEvent[], type: FunnelEvent["type"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== type) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const week = isoWeekKey(t);
    out[week] = (out[week] ?? 0) + 1;
  }
  return out;
}

/** Offer-link clicks per ISO week from the anonymous funnel events. */
export function clicksByWeek(events: FunnelEvent[]): Record<string, number> {
  return countByWeek(events, "item_clicked");
}

/**
 * REEA-1237 — shopper page views per ISO week: the client page-view beacon
 * count, i.e. serves the shopper's browser actually executed (one beacon per
 * served results page). This is the CTR denominator on the SAME basis and in
 * the SAME store/window as the click numerator above, so the two can be
 * divided without mixing a browser beacon with a server serve count. It is
 * an aggregate integer only — a `page_view` event carries no query, no
 * session id and no user id (see lib/events.ts).
 */
export function pageViewsByWeek(events: FunnelEvent[]): Record<string, number> {
  return countByWeek(events, "page_view");
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
  // REEA-1237 — the shopper denominator rides the same read as the click
  // numerator: one event store, one window, one basis.
  const res = weeklyResponse(read, clicksByWeek(events), windowWeeks, pageViewsByWeek(events));
  for (const [name, value] of Object.entries(gateHeaders)) res.headers.set(name, value);
  return res;
}

/**
 * REEA-996 — pure response builder, exported so the empty-read guard is
 * pinnable without a KV-bound runtime: a failed store read with no local
 * fallback data must fail loudly (503 + Retry-After), never silently
 * answer an empty map.
 *
 * REEA-1237 — `views` is the shopper page-view beacon count per week (see
 * pageViewsByWeek). Defaults to {} so pre-change callers keep their exact
 * response shape apart from the three new CTR fields, which read 0/null.
 */
export function weeklyResponse(
  read: WeeklyCountersRead,
  clicks: Record<string, number>,
  windowWeeks: number,
  views: Record<string, number> = {},
): Response {
  const weeks: Record<string, unknown> = {};
  const keys = Object.keys(read.weeks).sort().slice(-windowWeeks);
  for (const week of keys) {
    const w = read.weeks[week];
    weeks[week] = {
      searches: w.searches,
      zero_offer_searches: w.zero_offer_searches,
      offers_by_retailer: w.offers_by_retailer,
      // REEA-871/REEA-1148 — all-serve outcome split, published under honest
      // names (AC-2 choice: RENAMED). The stored counter has always folded
      // cold AND warm serves; `cold_serves_*` implied cold-only and made the
      // W48 read look inconsistent with the cold band total. The cold/warm
      // split rides the disjoint latency band sets below.
      serves_full: w.cold_serves_full,
      serves_pending: w.cold_serves_pending,
      retailer_adapter_attempts: w.retailer_adapter_attempts,
      retailer_adapter_failures: w.retailer_adapter_failures,
      latency_band_lt_1s: w.latency_band_lt_1s,
      latency_band_1_3s: w.latency_band_1_3s,
      latency_band_3_10s: w.latency_band_3_10s,
      latency_band_gt_10s: w.latency_band_gt_10s,
      // REEA-1148 — derived cold p90 (ms) with the recording cap as the
      // 3–10 s band's real upper edge. Not stored, not a new counter.
      latency_p90_ms: coldBandP90Ms(w),
      // REEA-1078 — warm-serve bands: a fresh memo hit's SERVE clock, kept
      // disjoint from the cold collection bands above. Cold + warm == searches.
      latency_warm_band_lt_1s: w.latency_warm_band_lt_1s,
      latency_warm_band_1_3s: w.latency_warm_band_1_3s,
      latency_warm_band_3_10s: w.latency_warm_band_3_10s,
      latency_warm_band_gt_10s: w.latency_warm_band_gt_10s,
      // REEA-1078 — comparison depth: one aggregate per week, never per query
      // or per card (Data Minimization). ratio is derived, 0 when no cards.
      comparison_depth: {
        // REEA-1178 AC5 — the payload states its OWN definition, so a reader
        // never has to infer the population behind the ratio: distinct
        // in-market merchants with a non-flagged offer, over the results-page
        // shelf the shopper's page painted (one card per productId, duplicate
        // offer rows folded, possible-mismatch offers excluded).
        definition:
          "cards_multi_retailer ÷ cards_total over the served results-page shelf: a card counts when it carries ≥2 distinct in-market merchants with a non-flagged offer (sanity status ok and ratioToMedian ≥ 0.1). Cards are deduped by productId and offer rows by merchant+price+URL, so duplicate rows, bundle twins and possible-mismatch accessory offers never inflate the number. cross_market_cards counts cards with no in-market retailer at all (a foreign-only card), recorded separately and never as depth.",
        cards_total: w.comparison_cards_total,
        cards_multi_retailer: w.comparison_cards_multi_retailer,
        // REEA-1207 (Bet 7B Addition 2) — cards whose only offers are
        // cross-market. They are recorded HERE and never in
        // cards_multi_retailer: a Saudi-only panadol shelf is a price list with
        // a foreign storefront, not a Kuwait comparison.
        cross_market_cards: w.comparison_cards_cross_market,
        ratio: w.comparison_cards_total > 0 ? w.comparison_cards_multi_retailer / w.comparison_cards_total : 0,
        // REEA-1178 AC5 — the pre-change weekly panel read 17.13% under the
        // old (contaminated) fold: flagged accessory merges and duplicate rows
        // counted as comparison depth. It is published BESIDE the post-change
        // number, never compared across the change — the population and the
        // merchant rule both moved.
        pre_change_reference: {
          ratio: 0.1713,
          basis:
            "W48 weekly panel before REEA-1178: cards_multi_retailer ÷ cards_total counted flagged accessory merges and duplicate rows. Read it beside the post-change ratio, never as a trend across this change.",
        },
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
      // REEA-1142 AC5 — offers served outside the selected market (integer
      // aggregate; no identifiers).
      cross_market_offers: w.cross_market_offers,
      // REEA-1200 (Bet 7C fold-in, AC 7C-3/7C-4) — the CTR denominators as
      // SEPARATE integers, never one blended figure: raw is every served
      // search; clean is the same population minus the named bot/health-check
      // serves. The subtraction is exactly `bot_serves` (published beside
      // them), and clean ≤ raw holds by construction even on a hostile blob.
      ctr_denominator_raw: w.searches,
      ctr_denominator_clean: Math.max(0, w.searches - Math.min(w.bot_serves, w.searches)),
      bot_serves: w.bot_serves,
      offer_link_clicks: clicks[week] ?? 0,
      // REEA-1237 — the SHOPPER-basis CTR denominator: the client page-view
      // beacon count, i.e. serves a shopper's browser actually executed. It
      // is the same integer as `ctr_denominator_shopper` by construction (the
      // shopper basis is exactly this count — there is no further
      // subtraction), published under both names the brief names so a reader
      // never has to infer which is which. Both sides of the CTR come from
      // this ONE anonymous event store and its 90-day raw window, so the
      // numerator and denominator share a basis instead of pairing a browser
      // click beacon with a server serve count. Aggregate integers only.
      shopper_serves: views[week] ?? 0,
      ctr_denominator_shopper: views[week] ?? 0,
      // Derived, never stored: a fraction (multiply by 100 for percent), or
      // null — never 0 — when the week has no shopper serve to divide by, OR
      // when the week began before the page-view beacon shipped (a straddling
      // week would divide a full-week click numerator by a partial-week view
      // denominator and overstate the rate; see shopperBasisCompleteForWeek).
      offer_link_ctr_shopper:
        (views[week] ?? 0) > 0 && shopperBasisCompleteForWeek(week)
          ? (clicks[week] ?? 0) / (views[week] as number)
          : null,
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
      // REEA-1009 S1b / REEA-1148 — metric honesty (bet #2 spec v1.0 §5,
      // AC-6(c)/AC-8). Always on the payload, not bet-flag-gated: the W49
      // read found it missing on the served stamp, which is the AC-6c defect
      // this fixes. Pure reporting text — no counter changes, no new
      // instrumentation (AC-4/REEA-865 stand), bands untouched (REEA-884).
      methodology: {
        latency_band_clock:
          "fan-out start → converged-chain recording at the structural tail cap: RESULTS_COMPLETION_BUDGET_MS (1800 ms) + STAGE_TAIL_HEADROOM_MS (6200 ms) + 500 ms settle margin = 8.5 s. The results after() tail now records on that bounded wait (REEA-1148), so a cold serve is never banded past the cap; latency_band_gt_10s is unreachable for a serve recorded by this build.",
        p90:
          "REEA-884 band-interpolated inside the containing band (r = ceil(0.9 × n), linear within the band); the 3–10 s band's real upper edge is the 8.5 s recording cap, so the derived latency_p90_ms cannot report a tail past the cap. A figure above 8.5 s is interpolation, not a measured tail.",
        shopper_visible_targets:
          "first-offer p75 ≤ 2.0 s (G3 guard — staged first-offer flush must not get slower); full-offer follow-up-complete ≤ 8.5 s (the recording cap); blocking aggregate gates: latency_band_gt_10s == 0 and serves_pending < 5% weekly (AC-8, ratified on REEA-1002; serves_pending is the all-serve count, a superset of cold pending, so a pass is conservative)",
        counter_naming:
          "AC-2 choice: RENAMED, not redefined. serves_full / serves_pending are the all-serve outcome split (formerly cold_serves_full / cold_serves_pending, whose names wrongly implied cold-only while the counter also folded warm serves). Cold and warm are not conflated: the disjoint latency_band_* / latency_warm_band_* sets carry that split, and serves_full + serves_pending == searches == sum(cold bands) + sum(warm bands) for every week, including weeks recorded before this change.",
        // REEA-1200 (Bet 7C fold-in) — AC 7C-3: each CTR denominator states
        // its own population on the wire. AC 7C-4: the difference is exactly
        // the named `bot_serves` counter, published beside both so the
        // subtraction is auditable and clean ≤ raw holds by construction.
        ctr_denominators:
          "ctr_denominator_raw = every served live search counted by `searches` (one results-page fan-out serve = one search; bots included). ctr_denominator_clean = the SAME population minus `bot_serves`: serves whose User-Agent matched the shared bot/health-check predicate (lib/bot-ua.ts) — smoke probes, QA probes that identify as bots, uptime pingers, and missing-UA fetchers. clean = max(0, raw − min(bot_serves, raw)), so ctr_denominator_clean ≤ ctr_denominator_raw always, and the difference is attributable to exactly `bot_serves`. Both are aggregate integers; no per-user identifier, no per-query row. Neither is the CTR basis: they are server serve counts, published for continuity.",
        // REEA-1237 — AC-2: the CTR is published on the SHOPPER basis and the
        // numerator and denominator populations are named on the wire. AC-4:
        // the arithmetic is reproducible from the payload alone (clicks ÷
        // shopper_serves). AC-5: the beacon stores no identifier.
        ctr_shopper:
          "offer_link_ctr_shopper = offer_link_clicks ÷ ctr_denominator_shopper. NUMERATOR basis: browser `item_clicked` beacons on offer links (results shelf and product-detail CTAs) from the anonymous funnel store — the same store, 90-day raw retention and clock as the denominator. DENOMINATOR basis: browser `page_view` beacons, one per served results page (query present), i.e. serves a shopper's own browser actually executed; shopper_serves and ctr_denominator_shopper are the same integer by construction (the shopper basis is exactly this count, no further subtraction). Both sides are client beacons, so a crawler that never executes JS contributes to neither — that is the shared basis the server-side ctr_denominator_clean could not provide. The transport drops `page_view` for the shared bot/health-check User-Agent predicate (lib/bot-ua.ts), so headless QA/smoke probes (which DO execute JS) do not inflate the denominator; the click numerator stays the unfiltered funnel stream (REEA-973), so a bot that clicks without a counted view is the only bot-side asymmetry, and QA click volume is negligible beside shopper views. The denominator counts results-page serves only; a product-detail offer CTA click (no shopper query, REEA-1078) is therefore a numerator-only increment, so it can only overstate the rate — read the ratio as an upper bound while such clicks exist. offer_link_ctr_shopper is a fraction (× 100 for percent) and is null when a week has no shopper serve, never 0, so an absent basis cannot read as a 0% rate. It is ALSO null for a week that began before the beacon shipped: such a week would pair a full-week click numerator with a partial-week view denominator and overstate the rate (the W48 read of 5 clicks ÷ 1 post-ship view would have shown 500%). The beacon shipped 2026-11-27, so shopper_serves is published from that day but the first week with a computable shopper CTR is the first full week after it (W49). A `page_view` event persists only `type`, a random per-event id and the server ingestion timestamp — no session, user, query or fingerprint identifier (AC-5). The 0.55% CTA success bar is judged on this field.",
        source: "REEA-1148 bet #2 AC-6c/AC-8; REEA-1009 S1b; REEA-1200 bet 7C AC 7C-3/7C-4; REEA-1237 shopper CTR basis; band definitions unchanged (REEA-871/REEA-884)",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
