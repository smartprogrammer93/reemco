/**
 * REEA-807 — lightweight outcome instrumentation: server-side aggregate
 * counters in weekly buckets. No PII, no user identifiers, no query text —
 * the stored schema carries only integer counters and retailer names (the
 * same names the coverage line already renders). No third-party scripts and
 * no client surface: everything here runs server-side (results page `after()`
 * tail, metrics routes, ops scripts).
 *
 * REEA-871 — approved aggregate extension, still counters and retailer names
 * only: per-week cold-serve outcome split (cold_serves_full / pending,
 * exactly one bump per search), per-retailer adapter attempts/failures from
 * the round-one fan-out, and serve latency bands (<1 s / 1–3 s / 3–10 s /
 * >10 s — exactly one per search; raw latencies never stored, the weekly
 * read derives p90 from the band counts).
 *
 * Buckets are keyed by ISO week ("2026-W37") so the PM snapshot is a plain
 * weekly series. Raw per-query content is deliberately NOT stored here —
 * query-level detail lives in the REEA-37 funnel store under its own
 * 90-day retention and only resurfaces as aggregate top-terms.
 *
 * REEA-1078 — two aggregate additions, still counters only:
 *  - comparison depth: `comparison_cards_total` / `comparison_cards_multi_retailer`
 *    count results-page SHELF cards per serve and how many carried offers from
 *    ≥2 distinct retailers (the core comparison promise, previously
 *    unmeasured). REEA-1099 — the population is the rendered primary slice
 *    (see results-shelf.ts), never every product the snapshot carries: the
 *    related band and selection-dropped rows are not result cards. No
 *    per-query or per-card data is stored — only the two totals.
 *  - warm-serve latency: a fresh query-memo hit runs no fan-out, so its wall
 *    clock is the SERVE clock (request → finalized response), not the cold
 *    collection clock. Warm serves land in `latency_warm_band_*` (same edges)
 *    instead of the cold `latency_band_*`; the two band sets sum to `searches`,
 *    so a repeat shopper's experience is separable from a cold collection.
 *    Without the split every warm serve read as 3–10 s cold and the counter
 *    could not answer "what does a repeat shopper experience" (REEA-1074 F4).
 *
 * Storage contract mirrors event-store.ts (REEA-233). REEA-1035 — the
 * shared-KV layout is per-field atomic counters: every increment is one
 * `SharedKv.incr(key, ttl)` under `metrics:weekly:v2:<isoWeek>:<field>`
 * (per-retailer entries get one key per retailer). An increment then lands
 * whenever the store accepts ANY write — no read gates the write, and
 * server-side INCR cannot lose updates to concurrent serves. The two
 * fragilities of the retired v1 full-blob read-modify-write (REEA-1034:
 * a failed shared read deliberately skipped the write and shed 100% of
 * volume to the ephemeral layer; concurrent RMW collapsed to
 * last-writer-wins) are gone by construction. The read side aggregates the
 * per-week keys (discovered via `SharedKv.keys`/`mget`) and dual-reads the
 * frozen v1 blob (`metrics:weekly:v1`) so history recorded before the
 * layout change still counts — v1 is never written again, so the union of
 * the frozen blob and the v2 keys is the true total, never a double count.
 * Without a binding (local dev, tests) the per-process disk file is the
 * whole store. The two layers are never merged on read while the shared
 * read is healthy (a v2 increment that degraded to the local layer after a
 * failed INCR is visible only when the shared read itself fails — the same
 * posture as v1), so a re-mirror cannot double-count. Every call is
 * best-effort: a storage hiccup degrades to a dropped increment, never to a
 * failed request — instrumentation must not break the shopper path.
 *
 * Server-only module (node:fs); never import from client code.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSharedKv, type SharedKv } from "@/lib/collect/kv";
// REEA-1178 — the ONE offer-row integrity definition: the depth fold reads the
// same merchant/dedupe/mismatch rules the results card renders.
import { comparisonMerchantsOf } from "@/lib/offer-integrity";
import type { CountryCode } from "@/lib/country";

/** Weeks kept in the store (raw counters older than this are pruned on write). */
export const RETENTION_WEEKS = 26;

/** Shared-KV key holding the whole weekly counter blob. */
export const METRICS_KV_KEY = "metrics:weekly:v1";

/**
 * REEA-1035 — per-field atomic counter layout: every weekly counter is its
 * own key under this prefix, written with `SharedKv.incr`. Key shape:
 * `metrics:weekly:v2:<isoWeek>:<field>[:<retailer>]` — scalar counters are
 * one key, per-retailer map entries one key per retailer, and the link-smoke
 * methodology annotation rides one string key (`ls_note`) per week.
 */
export const METRICS_WEEKLY_V2_PREFIX = "metrics:weekly:v2";

/** Outlive the retention window so TTL alone never drops a live week. */
export const METRICS_KV_TTL_S = (RETENTION_WEEKS * 7 + 7) * 24 * 60 * 60;

/** Distinct retailer names kept per week; overflow folds into "other". */
export const MAX_RETAILERS_PER_WEEK = 48;

export interface LinkSmokeCounters {
  /** Smoke runs recorded. */
  runs: number;
  /** Offer URLs checked across all runs. */
  checked: number;
  /** Checked URLs that answered dead (non-2xx/3xx or unreachable).
   *  REEA-935 — a bot-wall challenge is never recorded here (see challenge). */
  dead: number;
  /** REEA-935 — checked URLs whose final answer was `ok` (per-outcome
   *  aggregates per the REEA-934 spec: dead rate = dead / (ok + dead), so a
   *  challenge outcome never shrinks the denominator's trustworthiness). */
  ok: number;
  /** REEA-935 — checked URLs that kept answering a bot-wall challenge (CF
   *  challenge 403 / 429) after the backoff retry. Surfaced as a visible
   *  unknown — an unknown is never silently counted dead, never dropped. */
  challenge: number;
  by_retailer: Record<string, { checked: number; dead: number; challenge: number }>;
  /**
   * REEA-934 Change 4 — methodology annotation stamped by ops (never by the
   * smoke run itself). The counters keep their original values; the flags
   * only tell downstream baseline consumers (REEA-930) how to read them.
   */
  checkerContaminated?: boolean;
  methodologyNote?: string;
}

/**
 * REEA-871 — serve latency band names, ascending. Each recorded serve lands
 * in exactly one band by wall-clock time from fan-out start to the after()
 * recording, so the four bands always sum to `searches` for the week. Raw
 * latencies are never stored — the weekly read derives p90 from these counts
 * (interpolated inside the containing band; documented in the REEA-871
 * completion note and the next weekly-read doc).
 */
export type LatencyBand =
  | "latency_band_lt_1s"
  | "latency_band_1_3s"
  | "latency_band_3_10s"
  | "latency_band_gt_10s";

/**
 * REEA-1078 — warm-serve latency band names, ascending. A fresh query-memo
 * hit runs NO fan-out, so its wall clock is the serve clock (request start →
 * finalized response, recorded in the page's after() tail) rather than the
 * cold collection clock the four bands above measure. Same edges; the two
 * band sets are disjoint by serve kind and together sum to `searches`.
 */
export type WarmLatencyBand =
  | "latency_warm_band_lt_1s"
  | "latency_warm_band_1_3s"
  | "latency_warm_band_3_10s"
  | "latency_warm_band_gt_10s";

/** Band edges in ms: <1000 | [1000,3000) | [3000,10000] | >10000. */
export const LATENCY_BAND_EDGES_MS = { lt: 1_000, mid: 3_000, top: 10_000 } as const;

/** Pure: the single band a serve latency belongs to (edges documented above). */
export function latencyBandOf(latencyMs: number): LatencyBand {
  const t = typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0;
  if (t < LATENCY_BAND_EDGES_MS.mid) return t < LATENCY_BAND_EDGES_MS.lt ? "latency_band_lt_1s" : "latency_band_1_3s";
  return t <= LATENCY_BAND_EDGES_MS.top ? "latency_band_3_10s" : "latency_band_gt_10s";
}

/** REEA-1078 — the warm-serve counterpart of latencyBandOf (same edges). */
export function warmLatencyBandOf(latencyMs: number): WarmLatencyBand {
  const t = typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0;
  if (t < LATENCY_BAND_EDGES_MS.mid) {
    return t < LATENCY_BAND_EDGES_MS.lt ? "latency_warm_band_lt_1s" : "latency_warm_band_1_3s";
  }
  return t <= LATENCY_BAND_EDGES_MS.top ? "latency_warm_band_3_10s" : "latency_warm_band_gt_10s";
}

/**
 * REEA-1148 — the structural recording cap for a cold serve's latency band:
 * RESULTS_COMPLETION_BUDGET_MS (1800) + STAGE_TAIL_HEADROOM_MS (6200) + the
 * 500 ms settle margin the collection layer's own tail race uses. The
 * results after() tail now records on this bound (see convergedWithinCap in
 * lib/collect/live-search.ts), so a cold serve cannot be banded past it and
 * the >10 s band is unreachable for a serve recorded by this build.
 */
export const COLD_RECORDING_CAP_MS = 8_500;

/**
 * REEA-884/REEA-1148 — derived cold-serve p90 from the four band counts.
 *
 * Rank r = ceil(0.9 × n), then linear interpolation inside the containing
 * band (the REEA-884 formula). REEA-1148: the 3–10 s band's real upper edge
 * is the recording cap, not 10 s — a serve still converging at the cap is
 * recorded AT the cap, so interpolating all the way to 10 s reports a tail
 * no serve measured (the W48 9.45 s figure was exactly that artifact). The
 * >10 s band is legacy-only now; its true value is unknown once recorded, so
 * it interpolates inside [10 s, 10 s]. Returns null for an empty week.
 *
 * Derived, never stored: no new counter and no per-query data (AC-1).
 */
export function coldBandP90Ms(bands: {
  latency_band_lt_1s: number;
  latency_band_1_3s: number;
  latency_band_3_10s: number;
  latency_band_gt_10s: number;
}): number | null {
  const counts = [
    clampCount(bands.latency_band_lt_1s),
    clampCount(bands.latency_band_1_3s),
    clampCount(bands.latency_band_3_10s),
    clampCount(bands.latency_band_gt_10s),
  ];
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return null;
  const rank = Math.ceil(0.9 * n); // 1-based, the REEA-884 rank
  const edges: Array<{ count: number; lo: number; hi: number }> = [
    { count: counts[0], lo: 0, hi: LATENCY_BAND_EDGES_MS.lt },
    { count: counts[1], lo: LATENCY_BAND_EDGES_MS.lt, hi: LATENCY_BAND_EDGES_MS.mid },
    {
      count: counts[2],
      lo: LATENCY_BAND_EDGES_MS.mid,
      hi: Math.min(LATENCY_BAND_EDGES_MS.top, COLD_RECORDING_CAP_MS),
    },
    { count: counts[3], lo: LATENCY_BAND_EDGES_MS.top, hi: LATENCY_BAND_EDGES_MS.top },
  ];
  let seen = 0;
  for (const b of edges) {
    if (b.count <= 0) continue;
    if (rank <= seen + b.count) {
      const within = (rank - seen) / b.count;
      return Math.round(b.lo + within * (b.hi - b.lo));
    }
    seen += b.count;
  }
  return LATENCY_BAND_EDGES_MS.top;
}

/**
 * REEA-1078 — which clock a serve's latency belongs to. "warm" = a cached
 * live answer led the shopper's first paint (a fresh memo hit, or a
 * stale-while-revalidate repeat whose cached snapshot served first while the
 * live run deepened behind it), so the recorded wall clock is the SERVE clock
 * — what a repeat shopper actually experiences. "cold" = no cached first
 * paint existed, so the recorded wall clock is the cold collection clock.
 * Default "cold" keeps every pre-change caller/tests byte-identical.
 */
export type ServeKind = "cold" | "warm";

/** REEA-1078/REEA-1099 — the aggregate comparison depth of one serve's
 *  RESULTS-PAGE SHELF card set (the primary slice the page paints, derived
 *  through results-shelf.ts — not every product in the snapshot). */
export interface ComparisonDepth {
  /** Results-page shelf cards painted for this serve. */
  cardsTotal: number;
  /** Cards carrying offers from ≥2 DISTINCT retailers. */
  cardsMultiRetailer: number;
}

/** REEA-871 — how the converged answer stood at after() recording time:
 *  "full" when no retailer was still pending/staged, "pending" otherwise. */
export type ServeOutcome = "full" | "pending";

export interface WeekCounters {
  /** Live searches served (one fan-out page serve = one search). */
  searches: number;
  /** Searches whose converged answer carried zero offers. */
  zero_offer_searches: number;
  /** Offers delivered per retailer (the coverage-line `hits`, summed). */
  offers_by_retailer: Record<string, number>;
  /**
   * REEA-871 — cold-serve outcome split. Every `searches` increment bumps
   * exactly one of the two, so `cold_serves_full + cold_serves_pending ==
   * searches` holds per week by construction.
   */
  cold_serves_full: number;
  cold_serves_pending: number;
  /** REEA-871 — adapter invocations per retailer that reached a network call
   *  or terminal failure (round-one fan-out; same retailer keys as
   *  offers_by_retailer). */
  retailer_adapter_attempts: Record<string, number>;
  /** REEA-871 — adapters that returned an error / empty-due-to-error outcome.
   *  Folded clamped to the attempts so `failures ≤ attempts` holds per week. */
  retailer_adapter_failures: Record<string, number>;
  /** REEA-871 — serve latency bands (see LatencyBand); cold collection only
   *  (REEA-1078). Warm serves land in latency_warm_band_* instead. */
  latency_band_lt_1s: number;
  latency_band_1_3s: number;
  latency_band_3_10s: number;
  latency_band_gt_10s: number;
  /** REEA-1078 — warm-serve latency bands (see WarmLatencyBand). Cold bands +
   *  warm bands == searches, so every serve lands in exactly one band. */
  latency_warm_band_lt_1s: number;
  latency_warm_band_1_3s: number;
  latency_warm_band_3_10s: number;
  latency_warm_band_gt_10s: number;
  /** REEA-1078/REEA-1099 — comparison depth totals over results-page shelf
   *  cards (see ComparisonDepth). cards_multi_retailer ≤ cards_total by
   *  construction. */
  comparison_cards_total: number;
  comparison_cards_multi_retailer: number;
  /**
   * REEA-1114 AC6 — served searches whose visible results were zero but an
   * ACTIVE filter (the default In stock selection or the market selection)
   * hid ≥1 confident match. The false-empty rate is this counter ÷ searches;
   * it is the only measurement of the trust failure the W48 empty-state rate
   * could not see (the search did have offers — they were filtered out).
   * Aggregate integer only: no query text, no identifiers, no per-query row.
   */
  filtered_empty_searches: number;
  /**
   * REEA-1141 AC-4 — duplicate cards the served streamed document painted:
   * cards that repeated a productId an earlier flush already painted. Folded
   * over the SAME paint chain the renderer runs (lib/results-shelf.ts), so it
   * measures the real inflation, not a counterfactual. 0 is the healthy read
   * (one card per product); a positive value means `comparison_cards_total`
   * over-counts and the reader can subtract it. Aggregate integer only — no
   * card ids, no per-query row (Data Minimization).
   */
  duplicate_cards: number;
  /**
   * REEA-1142 AC5 — served offers whose market differs from the surface's
   * selected market (a danube.sa SAR row on a Kuwait search). The counter
   * makes the cross-market share of the served shelf measurable without
   * storing anything per offer: aggregate integer only, no query text, no
   * identifiers.
   */
  cross_market_offers: number;
  /**
   * REEA-1200 (Bet 7C fold-in) — served live searches whose User-Agent
   * matched the shared bot/health-check predicate (lib/bot-ua.ts): smoke
   * probes, QA probes that identify as bots, uptime pingers and missing-UA
   * fetchers. It is the ONE named counter behind the CTR denominator
   * subtraction: `ctr_denominator_raw - ctr_denominator_clean == bot_serves`
   * by construction. Aggregate integer only — the UA string itself is never
   * stored (Data Minimization).
   */
  bot_serves: number;
  link_smoke: LinkSmokeCounters;
}

export type WeekCountersMap = Record<string, WeekCounters>;

export interface MetricsBlob {
  version: 1;
  weeks: WeekCountersMap;
}

function emptyLinkSmoke(): LinkSmokeCounters {
  return { runs: 0, checked: 0, dead: 0, ok: 0, challenge: 0, by_retailer: {} };
}

export function emptyWeek(): WeekCounters {
  return {
    searches: 0,
    zero_offer_searches: 0,
    offers_by_retailer: {},
    cold_serves_full: 0,
    cold_serves_pending: 0,
    retailer_adapter_attempts: {},
    retailer_adapter_failures: {},
    latency_band_lt_1s: 0,
    latency_band_1_3s: 0,
    latency_band_3_10s: 0,
    latency_band_gt_10s: 0,
    latency_warm_band_lt_1s: 0,
    latency_warm_band_1_3s: 0,
    latency_warm_band_3_10s: 0,
    latency_warm_band_gt_10s: 0,
    comparison_cards_total: 0,
    comparison_cards_multi_retailer: 0,
    filtered_empty_searches: 0,
    duplicate_cards: 0,
    cross_market_offers: 0,
    // REEA-1200 — bot/health-check serves excluded from the clean CTR
    // denominator. Weeks stored before this extension backfill 0.
    bot_serves: 0,
    link_smoke: emptyLinkSmoke(),
  };
}

/** ISO-8601 week key ("2026-W37") for the given epoch ms, UTC math. */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const mondayShift = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayShift + 3);
  const t = new Date(thursday);
  const year = t.getUTCFullYear();
  const week1Thu = new Date(Date.UTC(year, 0, 4));
  const week1Mon = Date.UTC(year, 0, 4 - ((week1Thu.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday - week1Mon) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Keep only the trailing RETENTION_WEEKS buckets (ISO keys sort correctly). */
export function pruneWeeks(weeks: WeekCountersMap, keep = RETENTION_WEEKS): WeekCountersMap {
  const keys = Object.keys(weeks).sort();
  const out: WeekCountersMap = {};
  for (const k of keys.slice(-keep)) out[k] = weeks[k];
  return out;
}

function clampCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Retailer names are the only strings stored; sanitize + bound them. */
export function sanitizeMerchant(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 40);
}

function bumpRetailer(map: Record<string, number>, merchant: string, by: number): void {
  const name = sanitizeMerchant(merchant);
  if (!name) return;
  const key = Object.prototype.hasOwnProperty.call(map, name) || Object.keys(map).length < MAX_RETAILERS_PER_WEEK
    ? name
    : "other";
  map[key] = clampCount(map[key]) + by;
}

function ensureWeek(weeks: WeekCountersMap, week: string): WeekCounters {
  if (!weeks[week] || typeof weeks[week] !== "object") weeks[week] = emptyWeek();
  const w = weeks[week];
  if (!w.link_smoke || typeof w.link_smoke !== "object") w.link_smoke = emptyLinkSmoke();
  if (!w.offers_by_retailer || typeof w.offers_by_retailer !== "object") w.offers_by_retailer = {};
  if (!w.link_smoke.by_retailer || typeof w.link_smoke.by_retailer !== "object") {
    w.link_smoke.by_retailer = {};
  }
  // REEA-1078 — backfill only. The depth clamp must NOT run here: increments
  // arrive one key at a time, so clamping multi against a still-zero total
  // would zero a legitimate value (multi key applied before total key). The
  // invariant is clamped on the final read (normalizeWeek), after the merge.
  return backfillWeek(w);
}

/** Zero-fill every counter field on a week record (no cross-field clamps). */
function backfillWeek(week: WeekCounters): WeekCounters {
  for (const key of [
    "cold_serves_full",
    "cold_serves_pending",
    "latency_band_lt_1s",
    "latency_band_1_3s",
    "latency_band_3_10s",
    "latency_band_gt_10s",
    // REEA-1078 — warm-serve bands and comparison-depth totals. Weeks stored
    // before this extension backfill 0, exactly like the REEA-871 fields.
    "latency_warm_band_lt_1s",
    "latency_warm_band_1_3s",
    "latency_warm_band_3_10s",
    "latency_warm_band_gt_10s",
    "comparison_cards_total",
    "comparison_cards_multi_retailer",
    // REEA-1114 — the filter-aware empty-state counter. Weeks stored before
    // this extension backfill 0, like every earlier aggregate addition.
    "filtered_empty_searches",
    // REEA-1141 — duplicate cards painted by the streamed shelf. Weeks stored
    // before this extension backfill 0 (the healthy read).
    "duplicate_cards",
    // REEA-1142 — cross-market offer aggregate (integer, no identifiers).
    "cross_market_offers",
    // REEA-1200 — bot/health-check serves (the named CTR-denominator
    // subtraction). Weeks stored before this extension backfill 0.
    "bot_serves",
  ] as const) {
    week[key] = clampCount(week[key]);
  }
  for (const key of ["retailer_adapter_attempts", "retailer_adapter_failures"] as const) {
    if (!week[key] || typeof week[key] !== "object") week[key] = {};
  }
  return week;
}

/**
 * REEA-871 — backfill the aggregate-extension counters on weeks stored by an
 * earlier schema version (or clobbered by a partial write), so reads and the
 * weekly payload always carry complete non-negative integers. Existing
 * counter values are never rewritten (0 where a field was absent).
 * Idempotent: normalizing twice changes nothing beyond the first pass.
 * REEA-1078 — the final read also enforces cards_multi_retailer ≤
 * cards_total, after every increment has merged (see ensureWeek).
 */
export function normalizeWeek(week: WeekCounters): WeekCounters {
  backfillWeek(week);
  // A hostile/partial payload can never invert the depth invariant.
  week.comparison_cards_multi_retailer = Math.min(
    week.comparison_cards_multi_retailer,
    week.comparison_cards_total,
  );
  // REEA-935 — per-outcome link-smoke aggregates. Weeks stored before the
  // extension have no ok/challenge: challenge backfills 0 (the old checker
  // had no challenge vocabulary) and ok backfills to checked - dead, so the
  // derived dead rate of a legacy week stays exactly the rate it recorded.
  // Original checked/dead values are never rewritten (AC-4.1).
  const ls = week.link_smoke;
  if (ls && typeof ls === "object") {
    ls.runs = clampCount(ls.runs);
    ls.checked = clampCount(ls.checked);
    ls.dead = clampCount(ls.dead);
    ls.challenge = clampCount(ls.challenge);
    ls.ok =
      typeof ls.ok === "number" && Number.isFinite(ls.ok) && ls.ok >= 0
        ? Math.floor(ls.ok)
        : Math.max(0, ls.checked - ls.dead - ls.challenge);
    if (ls.by_retailer && typeof ls.by_retailer === "object") {
      for (const r of Object.values(ls.by_retailer)) {
        r.checked = clampCount(r.checked);
        r.dead = clampCount(r.dead);
        r.challenge = clampCount(r.challenge);
      }
    }
  }
  return week;
}

/** REEA-935 — derived per-outcome rates for the weekly read path.
 *  dead_rate = dead / (ok + dead): persistent challenges are excluded from
 *  the denominator but stay visible through challenge_rate =
 *  challenge / checked (an unknown is surfaced, never dropped). */
export function linkSmokeRates(ls: LinkSmokeCounters): { dead_rate: number; challenge_rate: number } {
  const deadDenominator = ls.ok + ls.dead;
  const checked = ls.checked > 0 ? ls.checked : deadDenominator + ls.challenge;
  return {
    dead_rate: deadDenominator > 0 ? ls.dead / deadDenominator : 0,
    challenge_rate: checked > 0 ? ls.challenge / checked : 0,
  };
}

/** The serve-time facts of one converged live search, ready to aggregate. */
export interface SearchOutcomeBase {
  zeroOffers: boolean;
  /** Per-retailer delivered-offer counts (the snapshot's coverage notes). */
  offersByRetailer: Record<string, number>;
  /** REEA-1078 — comparison depth over the same card set (see
   *  ComparisonDepth). Aggregate-only: two integers, no per-card data. */
  comparisonDepth?: ComparisonDepth;
  /** REEA-1141 AC-4 — duplicate cards the served streamed document painted
   *  (see lib/results-shelf.ts duplicateCardsOf). Aggregate integer only;
   *  absent = 0, so every pre-change caller stays byte-identical. */
  duplicateCards?: number;
}

/**
 * The serve-time facts of one converged live search, ready to aggregate.
 * REEA-871 adds the cold-serve outcome, the fan-out wall-clock latency and
 * the per-retailer adapter attempts/failures observed by the same serve —
 * all aggregate inputs, still no query content, no identifiers.
 */
export interface SearchOutcome extends SearchOutcomeBase {
  /**
   * REEA-871 — cold-serve outcome at after() recording time: "full" when the
   * converged answer had no pending/staged retailers remaining, "pending"
   * otherwise (finalized-at-budget answer, or the converged chain rejected
   * before a full answer existed). Exactly one of the two bumps per serve.
   */
  serveOutcome: ServeOutcome;
  /** REEA-871 — wall-clock ms from fan-out start to the after() recording;
   *  folded into exactly one latency band (see latencyBandOf). REEA-1078 —
   *  for a warm serve this is the SERVE clock (request start → finalized
   *  response) because a cached live answer led the first paint; the band set
   *  is chosen by serveKind. */
  serveLatencyMs: number;
  /** REEA-1078 — which clock serveLatencyMs measures (see ServeKind).
   *  "warm" = a cached live answer led the first paint (fresh memo hit or an
   *  SWR repeat): the value is the serve clock. "cold" = no cached first
   *  paint: the value is the collection clock. Absent = "cold" (pre-change
   *  callers stay byte-identical). */
  serveKind?: ServeKind;
  /** REEA-1078 — aggregate comparison depth of the served card set (see
   *  ComparisonDepth). Absent = 0 cards (e.g. a snapshot-less serve). */
  comparisonDepth?: ComparisonDepth;
  /** REEA-871 — adapter invocations per retailer that reached a network call
   *  or terminal failure in this serve's fan-out (retailer keys as stored by
   *  offersByRetailer). Absent = the serve ran no live fan-out (memo hit). */
  adapterAttempts?: Record<string, number>;
  /** REEA-871 — adapters that returned an error / empty-due-to-error outcome;
   * folded clamped to the same retailer's attempts. */
  adapterFailures?: Record<string, number>;
  /**
   * REEA-1114 AC6 — true when the served page's visible result set was zero
   * but an ACTIVE filter (default In stock, or the market selection) hid ≥1
   * confident match: the false-empty the shopper saw. One boolean per serve
   * folds into the aggregate `filtered_empty_searches` counter — no query
   * text, no per-query row (Data Minimization). Absent = false, so every
   * pre-change caller stays byte-identical.
   */
  filteredEmpty?: boolean;
  /**
   * REEA-1142 AC5 — offers on the served shelf whose market differs from the
   * selected market. One aggregate integer per serve; no per-offer record.
   */
  crossMarketOffers?: number;
  /**
   * REEA-1200 (Bet 7C fold-in) — true when this serve's User-Agent matched
   * the shared bot/health-check predicate (lib/bot-ua.ts): smoke probes, QA
   * probes that identify as bots, uptime pingers, missing-UA fetchers. One
   * boolean per serve folds into the aggregate `bot_serves` counter, the ONE
   * named subtraction behind the clean CTR denominator. The UA string itself
   * is never stored. Absent = false, so every pre-change caller stays
   * byte-identical.
   */
  botServe?: boolean;
}

/** Pure: fold one search outcome into the weekly buckets. */
export function applySearchOutcome(
  weeks: WeekCountersMap,
  week: string,
  outcome: SearchOutcome,
): WeekCountersMap {
  const w = ensureWeek(weeks, week);
  w.searches += 1;
  if (outcome.zeroOffers) w.zero_offer_searches += 1;
  // REEA-871 — cold-serve outcome: exactly one bucket per serve, so
  // cold_serves_full + cold_serves_pending == searches holds by construction.
  if (outcome.serveOutcome === "pending") w.cold_serves_pending += 1;
  else w.cold_serves_full += 1;
  // REEA-871 — exactly one latency band per serve, so the four cold bands
  // (plus the REEA-1078 warm bands) sum to searches. Only the band index is
  // stored; the raw ms never persist. A warm serve lands in the warm set:
  // its wall clock is the serve clock, not a collection clock.
  if (outcome.serveKind === "warm") {
    w[warmLatencyBandOf(outcome.serveLatencyMs)] += 1;
  } else {
    w[latencyBandOf(outcome.serveLatencyMs)] += 1;
  }
  // REEA-1078 — comparison depth totals. Clamped so multi ≤ total holds per
  // serve and per week; aggregate-only (two integers per serve, no cards).
  const cardsTotal = clampCount(outcome.comparisonDepth?.cardsTotal);
  const cardsMulti = Math.min(clampCount(outcome.comparisonDepth?.cardsMultiRetailer), cardsTotal);
  w.comparison_cards_total += cardsTotal;
  w.comparison_cards_multi_retailer += cardsMulti;
  // REEA-1141 AC-4 — duplicate cards painted by the served streamed shelf.
  // Clamped per serve so a hostile payload can never inflate the week; the
  // reader subtracts this from cards_total when it is non-zero.
  w.duplicate_cards += clampCount(outcome.duplicateCards);
  // REEA-1114 AC6 — the false-empty rate numerator: one increment per serve
  // whose visible set was zero because an active filter hid matches. Exactly
  // one bump per serve, so filtered_empty_searches ≤ searches holds.
  if (outcome.filteredEmpty === true) w.filtered_empty_searches += 1;
  // REEA-1142 AC5 — cross-market offer aggregate. Clamped like every counter;
  // no upper invariant beyond the served offer count.
  w.cross_market_offers += clampCount(outcome.crossMarketOffers);
  // REEA-1200 (Bet 7C fold-in) — bot/health-check serves. Exactly one bump per
  // bot serve, and the reader clamps it to `searches` so
  // ctr_denominator_clean ≤ ctr_denominator_raw holds even on a hostile blob.
  if (outcome.botServe === true) w.bot_serves += 1;
  for (const [merchant, hits] of Object.entries(outcome.offersByRetailer ?? {})) {
    const by = clampCount(hits);
    if (by > 0) bumpRetailer(w.offers_by_retailer, merchant, by);
  }
  // REEA-871 — adapter attempts/failures, same retailer keys as the offer
  // counts (sanitize + "other" overflow fold ride bumpRetailer). Failures
  // clamp to the same record's attempts so `failures ≤ attempts` can never
  // invert, per retailer, per week.
  for (const [merchant, n] of Object.entries(outcome.adapterAttempts ?? {})) {
    const attempts = clampCount(n);
    if (attempts === 0) continue;
    const failures = Math.min(clampCount(outcome.adapterFailures?.[merchant]), attempts);
    bumpRetailer(w.retailer_adapter_attempts, merchant, attempts);
    if (failures > 0) bumpRetailer(w.retailer_adapter_failures, merchant, failures);
  }
  return weeks;
}

/**
 * Pure: fold one dead-link smoke run into the weekly buckets.
 * REEA-935 — the run reports the per-outcome counts (ok is derived: every
 * checked URL lands in exactly one of ok/dead/challenge, so
 * ok = checked - dead - challenge by construction, clamped against hostile
 * payloads rather than trusted).
 */
export function applyLinkSmoke(
  weeks: WeekCountersMap,
  week: string,
  result: {
    checked: number;
    dead: number;
    challenge?: number;
    byRetailer: Record<string, { checked: number; dead: number; challenge?: number }>;
  },
): WeekCountersMap {
  const w = ensureWeek(weeks, week);
  const checked = clampCount(result.checked);
  const dead = Math.min(clampCount(result.dead), checked);
  const challenge = Math.min(clampCount(result.challenge), checked - dead);
  const ok = Math.max(0, checked - dead - challenge);
  w.link_smoke.runs += 1;
  w.link_smoke.checked += checked;
  w.link_smoke.dead += dead;
  w.link_smoke.ok += ok;
  w.link_smoke.challenge += challenge;
  for (const [merchant, c] of Object.entries(result.byRetailer ?? {}).slice(0, MAX_RETAILERS_PER_WEEK)) {
    const rChecked = clampCount(c?.checked);
    const rDead = Math.min(clampCount(c?.dead), rChecked);
    const rChallenge = Math.min(clampCount(c?.challenge), rChecked - rDead);
    if (rChecked === 0) continue;
    const name = sanitizeMerchant(merchant);
    if (!name) continue;
    const bucket = w.link_smoke.by_retailer[name] ?? { checked: 0, dead: 0, challenge: 0 };
    bucket.checked += rChecked;
    bucket.dead += rDead;
    bucket.challenge += rChallenge;
    w.link_smoke.by_retailer[name] = bucket;
  }
  return weeks;
}

/** REEA-1078/REEA-1099 — pure: comparison depth of a RESULTS-PAGE SHELF
 *  card set. A card counts as multi-retailer when its offers name ≥2 DISTINCT
 *  sanitized retailers; an offer with no usable merchant name cannot make a
 *  card a comparison, so it is ignored (never counted as a second retailer).
 *  Aggregate-only — the caller passes the exact shelf slice the page paints
 *  (resultsShelfCards), and only the two totals are stored (no card ids, no
 *  per-query data).
 *
 *  REEA-1178 AC2/AC3/AC5 — the depth definition the ticket asks the payload
 *  to state, enforced here: "distinct in-market merchants with a non-flagged
 *  offer". The fold now reads the SAME integrity helper as the card renderer
 *  (lib/offer-integrity.ts):
 *   - duplicate offer rows (same merchant + price + URL) count once, so a
 *     re-fetched listing cannot manufacture a second comparison lane;
 *   - an offer whose query-time sanity verdict is not `ok`, or whose
 *     ratioToMedian is below POSSIBLE_MISMATCH_RATIO (0.1), is a possible
 *     mismatch — live `fb1747d2`: the Anker AeroFit 2 card's Amazon.eg
 *     accessory at ratio 0.09997 was `ok` and still inflated this counter;
 *   - when a market scope is given, only that market's merchants count (a
 *     Saudi row is not a Kuwait comparison lane, REEA-1147 AC2). Callers that
 *     pass no scope keep the pre-change all-market fold for aggregate
 *     comparability of historical reads. */
export function comparisonDepthOf(
  products: readonly {
    offers?: readonly {
      merchant?: string;
      currency?: string;
      price?: number;
      url?: string;
      market?: string;
      sanity?: { status?: string; reason?: string; ratioToMedian?: number };
    }[];
  }[],
  scope?: CountryCode | null,
): ComparisonDepth {
  let cardsTotal = 0;
  let cardsMultiRetailer = 0;
  for (const p of products ?? []) {
    if (!p || typeof p !== "object") continue;
    cardsTotal += 1;
    const merchants = new Set<string>();
    for (const merchant of comparisonMerchantsOf(
      (p.offers ?? []).map((o) => ({
        merchant: typeof o?.merchant === "string" ? sanitizeMerchant(o.merchant) : "",
        price: typeof o?.price === "number" ? o.price : 0,
        currency: typeof o?.currency === "string" ? o.currency : "",
        url: typeof o?.url === "string" ? o.url : "",
        ...(typeof o?.market === "string" ? { market: o.market } : {}),
        ...(o?.sanity ? { sanity: o.sanity } : {}),
      })),
      scope ?? null,
    )) {
      // REEA-787's case-folded merchant identity: "Xcite" and "xcite" are the
      // same retailer spelling, never a second comparison lane. The helper
      // already case-folds and drops blank names.
      merchants.add(merchant);
    }
    if (merchants.size >= 2) cardsMultiRetailer += 1;
  }
  return { cardsTotal, cardsMultiRetailer };
}

/** Pure: map a converged LiveSearchResult onto the aggregate outcome.
 *  Only successful notes count (an error note delivered nothing); the
 *  zero-offer flag reads the product count of the converged snapshot. The
 *  REEA-871 serve fields ride separately — the caller knows the fan-out
 *  clock and the adapter telemetry, the snapshot does not.
 *
 *  REEA-1099 — the comparison depth is folded over the RESULTS-PAGE SHELF
 *  CARDS the caller passes (`cards`), NOT over every product the snapshot
 *  carries. The snapshot also holds related-band rows (rendered as chips, not
 *  result cards — REEA-964) and rows the country/stock selections drop before
 *  paint, so counting `snap.products` measured a different population than
 *  the plan's §4b gate names (measured live: 20 recorded vs 10 painted).
 *  Callers must derive `cards` through `resultsShelfCards` so the increment is
 *  exactly the shelf the shopper's page painted. */
export function searchOutcomeFromSnapshot(
  snap: {
    products: { offers?: readonly { merchant?: string }[] }[];
    notes: { merchant: string; hits: number; error?: string }[];
  },
  cards: readonly {
    offers?: readonly {
      merchant?: string;
      currency?: string;
      price?: number;
      url?: string;
      market?: string;
      sanity?: { status?: string; reason?: string; ratioToMedian?: number };
    }[];
  }[],
  // REEA-1178 AC3/AC5 — the market the card set speaks for, so the depth fold
  // counts only in-market comparison lanes. Omitted → pre-change all-market
  // fold (aggregate callers without a selection).
  scope?: CountryCode | null,
): SearchOutcomeBase {
  const offersByRetailer: Record<string, number> = {};
  for (const n of snap.notes ?? []) {
    if (n?.error) continue;
    if (clampCount(n?.hits) > 0) offersByRetailer[n.merchant] = clampCount(n.hits);
  }
  return {
    zeroOffers: (snap.products?.length ?? 0) === 0,
    offersByRetailer,
    comparisonDepth: comparisonDepthOf(cards, scope ?? null),
  };
}

/**
 * REEA-921 counter guardrail — "full" means the shopper's page reached full
 * offers. Two aggregate inputs decide it, both already in memory at the
 * after() recording:
 *  - `served`: the snapshot the SERVED DOCUMENT carried (the page's own
 *    final stage — settled, or a budget-finalized truncated answer),
 *  - `followUp`: the run's converged chain, which the registered follow-up
 *    feed folds into the open page when it lands full.
 * The page reached full offers when EITHER holds: the document itself was
 * settled, or the registered follow-up delivered the converged answer. A
 * truncated serve with a rejected/absent follow-up stays honest pending.
 * Pure; aggregate-only — no query text, no identifiers, nothing new stored
 * beyond the existing full/pending split.
 */
export function serveOutcomeOf(
  served: { settled?: boolean } | null | undefined,
  followUp: { settled?: boolean } | null | undefined,
): ServeOutcome {
  if (served && served.settled !== false) return "full";
  if (followUp && followUp.settled !== false) return "full";
  return "pending";
}

function defaultMetricsDir(): string {
  if (process.env.METRICS_DIR) return process.env.METRICS_DIR;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "/tmp/reemco-metrics";
  }
  return join(process.cwd(), ".metrics");
}

export const METRICS_DIR = defaultMetricsDir();

function metricsFile(dir = METRICS_DIR): string {
  return join(dir, "metrics.json");
}

function parseBlob(raw: string | null): MetricsBlob {
  if (!raw) return { version: 1, weeks: {} };
  try {
    const parsed = JSON.parse(raw) as MetricsBlob;
    if (!parsed || typeof parsed !== "object" || !parsed.weeks || typeof parsed.weeks !== "object") {
      return { version: 1, weeks: {} };
    }
    return { version: 1, weeks: parsed.weeks };
  } catch {
    return { version: 1, weeks: {} };
  }
}

/**
 * REEA-996 — parse that REPORTS failure instead of silently returning an
 * empty map: a stored blob that fails to parse is a corrupted/unreadable
 * store, which is a different fact from a store with no weeks.
 */
function parseBlobChecked(raw: string): WeekCountersMap | null {
  try {
    const parsed = JSON.parse(raw) as MetricsBlob;
    if (!parsed || typeof parsed !== "object" || !parsed.weeks || typeof parsed.weeks !== "object") {
      return null;
    }
    return parsed.weeks;
  } catch {
    return null;
  }
}

function readLocal(dir: string): MetricsBlob {
  try {
    return parseBlob(readFileSync(metricsFile(dir), "utf8"));
  } catch {
    return { version: 1, weeks: {} };
  }
}

/** Resolve the shared store; an injected instance (tests) wins. */
function sharedKv(opts: { kv?: SharedKv | null } = {}): SharedKv | null {
  if (opts.kv !== undefined) return opts.kv;
  return getSharedKv();
}

/** Read the retained weekly buckets (KV blob when bound, else local file).
 *  REEA-871 — every returned week is normalized, so weeks stored before the
 *  aggregate extension still read as complete integer counters (0 backfill)
 *  and the weekly payload never emits undefined fields. */
export async function readWeeklyCounters(
  opts: { dir?: string; kv?: SharedKv | null } = {},
): Promise<WeekCountersMap> {
  return (await readWeeklyCountersDetailed(opts)).weeks;
}

/**
 * REEA-996 — the classified read behind readWeeklyCounters. The intermittent
 * empty `weeks: {}` the PM loop observed was the two failure modes of the
 * shared read (KV unreachable / blob unparseable) collapsing into the same
 * `null` as an honestly missing key, then degrading to the per-instance
 * local layer — empty on a cold Vercel lambda — and answering 200 with an
 * empty map that downstream readers file as "no data". This read keeps the
 * facts apart:
 *  - source "kv": the shared blob answered and supplied the weeks;
 *  - source "local": the local layer supplied the weeks (no KV binding, a
 *    genuinely missing key, or a failed KV read degraded to local);
 *  - kvReadFailed: a KV store IS bound but the read FAILED (unreachable,
 *    error envelope, or unparseable blob) — an empty `weeks` under this flag
 *    is NOT evidence that the store has no data, and the weekly route must
 *    fail loudly instead of serving a silent empty map.
 */
export interface WeeklyCountersRead {
  weeks: WeekCountersMap;
  /** Which layer supplied the returned weeks. */
  source: "kv" | "local";
  /** True when a KV store is bound but the read failed (REEA-996). */
  kvReadFailed: boolean;
}

/** One classified attempt to read the shared blob. */
type KvBlobRead =
  | { state: "value"; weeks: WeekCountersMap }
  | { state: "missing" }
  | { state: "failed" };

async function readKvBlob(kv: SharedKv): Promise<KvBlobRead> {
  if (typeof kv.getChecked === "function") {
    try {
      const out = await kv.getChecked(METRICS_KV_KEY);
      if (!out.reachable) return { state: "failed" };
      if (out.value === null) return { state: "missing" };
      const weeks = parseBlobChecked(out.value);
      return weeks ? { state: "value", weeks } : { state: "failed" };
    } catch {
      return { state: "failed" };
    }
  }
  // Legacy fakes without getChecked keep the historical semantics: a null
  // read means "missing" and parseBlob's catch-all means empty weeks.
  const raw = await kv.get(METRICS_KV_KEY).catch(() => null);
  if (raw === null) return { state: "missing" };
  return { state: "value", weeks: parseBlob(raw).weeks };
}

/** readWeeklyCounters with the storage-fact classification (REEA-996). */
export async function readWeeklyCountersDetailed(
  opts: { dir?: string; kv?: SharedKv | null } = {},
): Promise<WeeklyCountersRead> {
  const kv = sharedKv(opts);
  const normalizeAll = (weeks: WeekCountersMap): WeekCountersMap => {
    for (const week of Object.values(weeks)) normalizeWeek(week);
    return weeks;
  };
  const readLocalNormalized = (): WeekCountersMap =>
    pruneWeeks(normalizeAll(readLocal(opts.dir ?? METRICS_DIR).weeks));
  if (kv) {
    // REEA-1035 — dual-read: the per-field atomic keys (post-change
    // increments) aggregated on top of the frozen v1 blob (pre-change
    // history). v1 is never written again, so blob ∪ keys is the true
    // total, never a double count. A store without the enumeration ops or
    // with a failed `keys` call falls back to the v1-only classified read
    // below — a partial keyspace must never pose as honest data.
    const v2 = await readKvWeeklyV2(kv);
    if (v2) {
      const blob = await readKvBlob(kv);
      const weeks = blob.state === "value" ? blob.weeks : {};
      for (const [week, w] of Object.entries(v2)) addWeekInto(weeks, week, w);
      return {
        weeks: pruneWeeks(normalizeAll(weeks)),
        source: "kv",
        // REEA-996 semantics preserved: a failed blob read is never
        // honest-empty. With v2 data present the weeks answer anyway (the
        // route only 503s when BOTH the classification says failed AND no
        // data could be read); with an empty keyspace the loud 503 stands.
        kvReadFailed: blob.state === "failed",
      };
    }
    const blob = await readKvBlob(kv);
    if (blob.state === "value") {
      return { weeks: pruneWeeks(normalizeAll(blob.weeks)), source: "kv", kvReadFailed: false };
    }
    return {
      weeks: readLocalNormalized(),
      source: "local",
      kvReadFailed: blob.state === "failed",
    };
  }
  return { weeks: readLocalNormalized(), source: "local", kvReadFailed: false };
}

/**
 * REEA-1035 — one atomic weekly increment: where the count goes, both as a
 * v2 key (write path) and as a fold into a WeekCountersMap (local
 * degradation + read-side merge). `by` is always the clamped, sanitized
 * delta computed from the record's overlay.
 */
type WeeklyDeltaTarget =
  | { t: "scalar"; f: WeeklyScalarField }
  | { t: "ls"; f: WeeklyLinkSmokeScalar }
  | {
      t: "map";
      m: "offers_by_retailer" | "retailer_adapter_attempts" | "retailer_adapter_failures";
      name: string;
    }
  | { t: "lsbr"; f: "checked" | "dead" | "challenge"; name: string };

type WeeklyDelta = WeeklyDeltaTarget & { week: string; by: number };

/** Scalar counter fields that live directly on the week record. */
const WEEKLY_SCALAR_FIELDS = [
  "searches",
  "zero_offer_searches",
  "cold_serves_full",
  "cold_serves_pending",
  "latency_band_lt_1s",
  "latency_band_1_3s",
  "latency_band_3_10s",
  "latency_band_gt_10s",
  // REEA-1078 — warm-serve bands and comparison-depth totals.
  "latency_warm_band_lt_1s",
  "latency_warm_band_1_3s",
  "latency_warm_band_3_10s",
  "latency_warm_band_gt_10s",
  "comparison_cards_total",
  "comparison_cards_multi_retailer",
  // REEA-1114 — filter-aware empty-state counter (one integer per week).
  "filtered_empty_searches",
  // REEA-1141 — duplicate-card aggregate (one integer per week).
  "duplicate_cards",
  // REEA-1142 — cross-market offer aggregate (one integer per week).
  "cross_market_offers",
  // REEA-1200 — bot/health-check serve aggregate (one integer per week).
  "bot_serves",
] as const;
type WeeklyScalarField = (typeof WEEKLY_SCALAR_FIELDS)[number];

/** Scalar counter fields that live on the week's link_smoke record. */
const WEEKLY_LS_SCALARS = ["runs", "checked", "dead", "ok", "challenge"] as const;
type WeeklyLinkSmokeScalar = (typeof WEEKLY_LS_SCALARS)[number];

/** The v2 key one increment lands under (atomic SharedKv.incr target). */
function weeklyV2Key(d: WeeklyDelta): string {
  const base = `${METRICS_WEEKLY_V2_PREFIX}:${d.week}`;
  switch (d.t) {
    case "scalar":
      return `${base}:${d.f}`;
    case "ls":
      return `${base}:ls_${d.f}`;
    case "map":
      return `${base}:${d.m === "offers_by_retailer" ? "offer" : d.m === "retailer_adapter_attempts" ? "att" : "fail"}:${d.name}`;
    case "lsbr":
      return `${base}:lsbr_${d.f}:${d.name}`;
  }
}

/** Fold one increment into a WeekCountersMap (local degradation + merge). */
function applyWeeklyDelta(weeks: WeekCountersMap, d: WeeklyDelta): void {
  const w = ensureWeek(weeks, d.week);
  switch (d.t) {
    case "scalar":
      w[d.f] += d.by;
      break;
    case "ls":
      w.link_smoke[d.f] += d.by;
      break;
    case "map":
      w[d.m][d.name] = clampCount(w[d.m][d.name]) + d.by;
      break;
    case "lsbr": {
      const b = w.link_smoke.by_retailer[d.name] ?? { checked: 0, dead: 0, challenge: 0 };
      b[d.f] += d.by;
      w.link_smoke.by_retailer[d.name] = b;
      break;
    }
  }
}

/**
 * REEA-1035 — diff a freshly-applied overlay against the empty week. The
 * generic `apply` closures only ever add counters to (or annotate) their
 * target week, so running one on a pristine overlay yields exactly the
 * increments the shared store needs — computed WITHOUT reading the store,
 * which is the whole point of the atomic layout (a read must never gate a
 * write again). The annotate-only string fields are not counters; they ride
 * the dedicated annotation path, not this diff.
 */
function weeklyDeltasFromOverlay(overlay: WeekCountersMap): WeeklyDelta[] {
  const incrs: WeeklyDelta[] = [];
  for (const [week, raw] of Object.entries(overlay)) {
    if (!raw || typeof raw !== "object") continue;
    const w = normalizeWeek(raw);
    for (const f of WEEKLY_SCALAR_FIELDS) {
      const by = clampCount(w[f]);
      if (by > 0) incrs.push({ week, t: "scalar", f, by });
    }
    for (const f of WEEKLY_LS_SCALARS) {
      const by = clampCount(w.link_smoke[f]);
      if (by > 0) incrs.push({ week, t: "ls", f, by });
    }
    for (const m of ["offers_by_retailer", "retailer_adapter_attempts", "retailer_adapter_failures"] as const) {
      for (const [name, by] of Object.entries(w[m])) {
        const n = clampCount(by);
        if (n > 0) incrs.push({ week, t: "map", m, name, by: n });
      }
    }
    for (const [name, r] of Object.entries(w.link_smoke.by_retailer)) {
      for (const f of ["checked", "dead", "challenge"] as const) {
        const by = clampCount(r?.[f]);
        if (by > 0) incrs.push({ week, t: "lsbr", f, name, by });
      }
    }
  }
  return incrs;
}

/** REEA-1035 — parse one v2 key back into where its value belongs. */
function parseWeeklyV2Key(
  key: string,
): { week: string; target: WeeklyDeltaTarget } | { week: string; note: true } | null {
  if (!key.startsWith(`${METRICS_WEEKLY_V2_PREFIX}:`)) return null;
  const parts = key.split(":");
  // metrics : weekly : v2 : <week> : <kind> [: <retailer> …]
  if (parts.length < 5) return null;
  const week = parts[3];
  const kind = parts[4];
  const name = parts.slice(5).join(":");
  if ((WEEKLY_SCALAR_FIELDS as readonly string[]).includes(kind)) {
    return { week, target: { t: "scalar", f: kind as WeeklyScalarField } };
  }
  switch (kind) {
    case "ls_runs":
      return { week, target: { t: "ls", f: "runs" } };
    case "ls_checked":
      return { week, target: { t: "ls", f: "checked" } };
    case "ls_dead":
      return { week, target: { t: "ls", f: "dead" } };
    case "ls_ok":
      return { week, target: { t: "ls", f: "ok" } };
    case "ls_challenge":
      return { week, target: { t: "ls", f: "challenge" } };
    case "offer":
    case "att":
    case "fail":
      if (!name) return null;
      return {
        week,
        target: {
          t: "map",
          m: kind === "offer" ? "offers_by_retailer" : kind === "att" ? "retailer_adapter_attempts" : "retailer_adapter_failures",
          name,
        },
      };
    case "lsbr_checked":
    case "lsbr_dead":
    case "lsbr_challenge":
      if (!name) return null;
      return { week, target: { t: "lsbr", f: kind.slice(5) as "checked" | "dead" | "challenge", name } };
    case "ls_note":
      return { week, note: true };
    default:
      return null; // unknown shape — ignore, forward compatible
  }
}

/** Add one week's counters on top of another map (read-side merge). */
function addWeekInto(dst: WeekCountersMap, week: string, src: WeekCounters): void {
  const w = ensureWeek(dst, week);
  for (const f of WEEKLY_SCALAR_FIELDS) w[f] += clampCount(src[f]);
  for (const f of WEEKLY_LS_SCALARS) w.link_smoke[f] += clampCount(src.link_smoke[f]);
  for (const m of ["offers_by_retailer", "retailer_adapter_attempts", "retailer_adapter_failures"] as const) {
    for (const [name, by] of Object.entries(src[m] ?? {})) {
      const n = clampCount(by);
      if (n > 0) w[m][name] = clampCount(w[m][name]) + n;
    }
  }
  for (const [name, r] of Object.entries(src.link_smoke.by_retailer ?? {})) {
    const b = w.link_smoke.by_retailer[name] ?? { checked: 0, dead: 0, challenge: 0 };
    b.checked += clampCount(r?.checked);
    b.dead += clampCount(r?.dead);
    b.challenge += clampCount(r?.challenge);
    w.link_smoke.by_retailer[name] = b;
  }
  if (src.link_smoke.checkerContaminated !== undefined) w.link_smoke.checkerContaminated = src.link_smoke.checkerContaminated;
  if (src.link_smoke.methodologyNote !== undefined) w.link_smoke.methodologyNote = src.link_smoke.methodologyNote;
}

/**
 * REEA-1035 — read the per-field atomic weekly counters. Enumerates the v2
 * keyspace (one `keys` call — the keyspace is bounded by the retention TTLs
 * and the read cadence is the PM loop), then one batched `mget`; a store
 * without either op (or a failed enumeration) returns null so the caller
 * falls back to the v1 blob read instead of reading a partial keyspace as
 * honest data. Missing keys read as 0; per-field values are plain INCR
 * integers.
 */
async function readKvWeeklyV2(kv: SharedKv): Promise<WeekCountersMap | null> {
  if (typeof kv.keys !== "function" || typeof kv.mget !== "function") return null;
  let names: string[] | null = null;
  try {
    names = await kv.keys(`${METRICS_WEEKLY_V2_PREFIX}:*`);
  } catch {
    names = null;
  }
  if (!names) return null;
  const weeks: WeekCountersMap = {};
  if (names.length === 0) return weeks;
  let values: (string | null)[] | null = null;
  try {
    values = await kv.mget(names);
  } catch {
    values = null;
  }
  if (!values || values.length !== names.length) {
    // Older fakes without mget: fall back to per-key reads (bounded by the
    // enumerated keyspace; the production store answers the batch).
    values = await Promise.all(names.map((k) => kv.get(k).catch(() => null)));
  }
  const notes: Record<string, { checkerContaminated: boolean; methodologyNote: string }> = {};
  names.forEach((key, i) => {
    const parsed = parseWeeklyV2Key(key);
    if (!parsed) return;
    const raw = values?.[i] ?? null;
    if ("note" in parsed) {
      if (raw) {
        try {
          const n = JSON.parse(raw) as { checkerContaminated?: unknown; methodologyNote?: unknown };
          notes[parsed.week] = {
            checkerContaminated: n.checkerContaminated === true,
            methodologyNote: typeof n.methodologyNote === "string" ? n.methodologyNote : "",
          };
        } catch {
          // a corrupted note degrades to no annotation, never to a failed read
        }
      }
      return;
    }
    const by = clampCount(Number.parseInt(raw ?? "", 10));
    if (by > 0) applyWeeklyDelta(weeks, { ...parsed.target, week: parsed.week, by });
  });
  for (const [week, note] of Object.entries(notes)) {
    const w = ensureWeek(weeks, week);
    w.link_smoke.checkerContaminated = note.checkerContaminated;
    w.link_smoke.methodologyNote = note.methodologyNote;
  }
  return weeks;
}

/** Apply `apply` to the buckets and persist (best-effort). KV-bound stores
 *  REEA-1035 — write per-field atomic increments (`SharedKv.incr`) computed
 *  from an overlay, so no read gates the write and concurrent serves cannot
 *  lose updates; increments whose INCR failed degrade to the local layer.
 *  Stores without `incr` (legacy test fakes) and unbound stores keep the v1
 *  read-modify-write over the local file. REEA-996 — on the legacy path,
 *  when the shared read FAILED the shared write is skipped: a
 *  read-modify-write over an unknown blob state would replace the shared
 *  26-week history with whatever this instance's local layer happened to
 *  hold (empty on a cold lambda). The increment degrades to the local layer
 *  instead — the same posture as a failed shared write. */
export async function updateWeeklyCounters(
  apply: (weeks: WeekCountersMap, week: string) => void,
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<WeekCountersMap> {
  const kv = sharedKv(opts);
  if (kv && typeof kv.incr === "function") return updateWeeklyCountersIncr(apply, kv, opts);
  return updateWeeklyCountersLocal(apply, opts);
}

/**
 * REEA-1035 — the atomic write path. Runs the caller's `apply` on a pristine
 * overlay, diffs it into per-field increments, and fires every INCR
 * independently (concurrently — bounded by MAX_RETAILERS_PER_WEEK per
 * record). No store read happens on this path at all: an increment lands
 * whenever the store accepts ANY write, and server-side INCR makes
 * concurrent serves additive instead of last-writer-wins. Note: the
 * MAX_RETAILERS_PER_WEEK fold becomes a per-write cap under this layout —
 * distinct weekly retailers are not countable without a read, which would
 * reintroduce the read-modify-write this change removes; the live retailer
 * universe is the four adapters, so the cap stays a hostile-payload bound.
 */
async function updateWeeklyCountersIncr(
  apply: (weeks: WeekCountersMap, week: string) => void,
  kv: SharedKv,
  opts: { now?: number; dir?: string },
): Promise<WeekCountersMap> {
  const now = opts.now ?? Date.now();
  const overlay: WeekCountersMap = {};
  apply(overlay, isoWeekKey(now));
  const incrs = weeklyDeltasFromOverlay(overlay);
  // Fire every increment independently (concurrently, bounded by
  // MAX_RETAILERS_PER_WEEK per record). One increment = one atomic
  // server-side op: it lands whenever the store accepts ANY write, no read
  // gates it, and concurrent serves cannot collapse it. A delta whose
  // atomic op fails (or, on stores without incrBy, partially lands) folds
  // only its remainder into the local layer — never re-sent to the shared
  // store, so a degradation cannot double count.
  const landed = await Promise.all(
    incrs.map(async (d) => {
      const key = weeklyV2Key(d);
      try {
        if (typeof kv.incrBy === "function") {
          return (await kv.incrBy(key, d.by, METRICS_KV_TTL_S)) === null ? d : null;
        }
        let done = 0;
        for (let i = 0; i < d.by; i++) {
          const r = await kv.incr?.(key, METRICS_KV_TTL_S);
          if (typeof r !== "number") break;
          done++;
        }
        return done === d.by ? null : { ...d, by: d.by - done };
      } catch {
        return d;
      }
    }),
  );
  const failed = landed.filter((d): d is WeeklyDelta => d !== null);
  if (failed.length > 0) {
    // Degraded increments fold into the per-instance local layer — the same
    // posture as a failed shared write in the v1 design (the window still
    // counts on this instance; never a failed request).
    const weeks = readLocal(opts.dir ?? METRICS_DIR).weeks;
    for (const d of failed) applyWeeklyDelta(weeks, d);
    writeLocal(pruneWeeks(weeks), opts.dir ?? METRICS_DIR);
  }
  const normalized: WeekCountersMap = {};
  for (const [week, w] of Object.entries(overlay)) normalized[week] = normalizeWeek(w);
  return pruneWeeks(normalized);
}

/** The pre-REEA-1035 local/read-modify-write path (legacy fakes + unbound). */
async function updateWeeklyCountersLocal(
  apply: (weeks: WeekCountersMap, week: string) => void,
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<WeekCountersMap> {
  const now = opts.now ?? Date.now();
  const week = isoWeekKey(now);
  const kv = sharedKv(opts);
  let weeks: WeekCountersMap;
  let skipSharedWrite = false;
  if (kv) {
    const blob = await readKvBlob(kv);
    if (blob.state === "value") {
      weeks = blob.weeks;
    } else {
      weeks = readLocal(opts.dir ?? METRICS_DIR).weeks;
      skipSharedWrite = blob.state === "failed";
    }
  } else {
    weeks = readLocal(opts.dir ?? METRICS_DIR).weeks;
  }
  apply(weeks, week);
  const pruned = pruneWeeks(weeks);
  const body = JSON.stringify({ version: 1, weeks: pruned } satisfies MetricsBlob);
  if (kv && !skipSharedWrite) {
    const ok = await kv.set(METRICS_KV_KEY, body, METRICS_KV_TTL_S).catch(() => false);
    if (!ok) {
      // Shared write failed — keep the increment on the local layer so the
      // window still counts on this instance (degraded, never lost request).
      writeLocal(pruned, opts.dir ?? METRICS_DIR);
    }
  } else {
    writeLocal(pruned, opts.dir ?? METRICS_DIR);
  }
  return pruned;
}

function writeLocal(weeks: WeekCountersMap, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = metricsFile(dir);
    const tmp = join(dir, `metrics.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ version: 1, weeks }));
    renameSync(tmp, file);
  } catch {
    // best-effort — same contract as the KV layer
  }
}

/** Record one served live search (server-side; call from the page's after()). */
export async function recordSearchOutcome(
  outcome: SearchOutcome,
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<void> {
  await updateWeeklyCounters((weeks, week) => applySearchOutcome(weeks, week, outcome), opts);
}

/** Record one dead-link smoke run (server-side; call from the ingest route). */
export async function recordLinkSmoke(
  result: {
    checked: number;
    dead: number;
    challenge?: number;
    byRetailer: Record<string, { checked: number; dead: number; challenge?: number }>;
  },
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<void> {
  await updateWeeklyCounters((weeks, week) => applyLinkSmoke(weeks, week, result), opts);
}

/**
 * REEA-934 Change 4 — stamp the methodology annotation on a recorded week's
 * link-smoke aggregate WITHOUT touching its counters (annotate, never
 * rewrite). `week` targets a past bucket (the W37 annotation); undefined
 * stamps the current week. A week with no stored record is left alone — an
 * annotation must not fabricate an empty bucket. Best-effort like every
 * store write.
 *
 * REEA-1035 — under the per-field atomic layout the annotation is one
 * idempotent SET of the whole note (`metrics:weekly:v2:<week>:ls_note`): a
 * full-object overwrite with no read-modify-write window, and the counters
 * ride their own atomic keys untouched. The never-fabricate guard reads the
 * classified store first — an ops-rate action that can afford a read,
 * unlike the serve-path writer. Degraded paths keep the v1 semantics.
 */
export async function annotateLinkSmoke(
  annotation: { checkerContaminated: boolean; methodologyNote: string },
  opts: { week?: string; now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<void> {
  const kv = sharedKv(opts);
  const now = opts.now ?? Date.now();
  const target = opts.week ?? isoWeekKey(now);
  if (kv && typeof kv.incr === "function") {
    const read = await readWeeklyCountersDetailed(opts);
    if (!read.weeks[target]) {
      // Same guard as the legacy closure: the week exists on the layer the
      // read could actually see, or the annotation does nothing at all.
      if (read.source === "kv") return;
    } else if (read.source === "kv") {
      const note = {
        checkerContaminated: annotation.checkerContaminated === true,
        // Same string hygiene as every stored string: control chars
        // stripped, bounded — the note is one sentence, not a document.
        methodologyNote: annotation.methodologyNote
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, 500),
      };
      const ok = await kv
        .set(`${METRICS_WEEKLY_V2_PREFIX}:${target}:ls_note`, JSON.stringify(note), METRICS_KV_TTL_S)
        .catch(() => false);
      if (ok) return;
      // shared SET failed → fall through; the local fold stamps whatever
      // the local layer holds (degraded, never a failed request).
    }
  }
  await updateWeeklyCountersLocal((weeks) => {
    const existing = weeks[target];
    if (!existing || typeof existing !== "object") return;
    const w = ensureWeek(weeks, target);
    w.link_smoke.checkerContaminated = annotation.checkerContaminated === true;
    // Same string hygiene as every stored string: control chars stripped,
    // bounded — the note is one sentence, not a document.
    w.link_smoke.methodologyNote = annotation.methodologyNote
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 500);
  }, opts);
}
