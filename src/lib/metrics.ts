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
 * Storage contract mirrors event-store.ts (REEA-233): when the shared KV
 * binding exists the counters live ONLY in the shared blob (read-modify-write,
 * last-write-wins — a concurrent increment can be lost, acceptable for
 * aggregate counters and documented here); without a binding (local dev,
 * tests) the per-process disk file is the whole store. The two layers are
 * never merged, so a re-mirror cannot double-count. Every call is
 * best-effort: a storage hiccup degrades to a dropped increment, never to a
 * failed request — instrumentation must not break the shopper path.
 *
 * Server-only module (node:fs); never import from client code.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSharedKv, type SharedKv } from "@/lib/collect/kv";

/** Weeks kept in the store (raw counters older than this are pruned on write). */
export const RETENTION_WEEKS = 26;

/** Shared-KV key holding the whole weekly counter blob. */
export const METRICS_KV_KEY = "metrics:weekly:v1";

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

/** Band edges in ms: <1000 | [1000,3000) | [3000,10000] | >10000. */
export const LATENCY_BAND_EDGES_MS = { lt: 1_000, mid: 3_000, top: 10_000 } as const;

/** Pure: the single band a serve latency belongs to (edges documented above). */
export function latencyBandOf(latencyMs: number): LatencyBand {
  const t = typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0;
  if (t < LATENCY_BAND_EDGES_MS.mid) return t < LATENCY_BAND_EDGES_MS.lt ? "latency_band_lt_1s" : "latency_band_1_3s";
  return t <= LATENCY_BAND_EDGES_MS.top ? "latency_band_3_10s" : "latency_band_gt_10s";
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
  /** REEA-871 — serve latency bands (see LatencyBand); sum to `searches`. */
  latency_band_lt_1s: number;
  latency_band_1_3s: number;
  latency_band_3_10s: number;
  latency_band_gt_10s: number;
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
  return normalizeWeek(w);
}

/**
 * REEA-871 — backfill the aggregate-extension counters on weeks stored by an
 * earlier schema version (or clobbered by a partial write), so reads and the
 * weekly payload always carry complete non-negative integers. Existing
 * counter values are never rewritten (0 where a field was absent).
 * Idempotent: normalizing twice changes nothing beyond the first pass.
 */
export function normalizeWeek(week: WeekCounters): WeekCounters {
  for (const key of ["cold_serves_full", "cold_serves_pending", "latency_band_lt_1s", "latency_band_1_3s", "latency_band_3_10s", "latency_band_gt_10s"] as const) {
    week[key] = clampCount(week[key]);
  }
  for (const key of ["retailer_adapter_attempts", "retailer_adapter_failures"] as const) {
    if (!week[key] || typeof week[key] !== "object") week[key] = {};
  }
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
   *  folded into exactly one latency band (see latencyBandOf). */
  serveLatencyMs: number;
  /** REEA-871 — adapter invocations per retailer that reached a network call
   *  or terminal failure in this serve's fan-out (retailer keys as stored by
   *  offersByRetailer). Absent = the serve ran no live fan-out (memo hit). */
  adapterAttempts?: Record<string, number>;
  /** REEA-871 — adapters that returned an error / empty-due-to-error outcome;
   * folded clamped to the same retailer's attempts. */
  adapterFailures?: Record<string, number>;
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
  // REEA-871 — exactly one latency band per serve, so the four bands sum to
  // searches. Only the band index is stored; the raw ms never persist.
  w[latencyBandOf(outcome.serveLatencyMs)] += 1;
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

/** Pure: map a converged LiveSearchResult onto the aggregate outcome.
 *  Only successful notes count (an error note delivered nothing); the
 *  zero-offer flag reads the product count of the converged snapshot. The
 *  REEA-871 serve fields ride separately — the caller knows the fan-out
 *  clock and the adapter telemetry, the snapshot does not. */
export function searchOutcomeFromSnapshot(snap: {
  products: unknown[];
  notes: { merchant: string; hits: number; error?: string }[];
}): SearchOutcomeBase {
  const offersByRetailer: Record<string, number> = {};
  for (const n of snap.notes ?? []) {
    if (n?.error) continue;
    if (clampCount(n?.hits) > 0) offersByRetailer[n.merchant] = clampCount(n.hits);
  }
  return { zeroOffers: (snap.products?.length ?? 0) === 0, offersByRetailer };
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

/** Apply `apply` to the buckets and persist (best-effort). KV-bound stores
 *  read-modify-write the shared blob; unbound stores rewrite the local file.
 *  REEA-996 — when the shared read FAILED, the shared write is skipped: a
 *  read-modify-write over an unknown blob state would replace the shared
 *  26-week history with whatever this instance's local layer happened to
 *  hold (empty on a cold lambda). The increment degrades to the local layer
 *  instead — the same posture as a failed shared write. */
export async function updateWeeklyCounters(
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
 */
export async function annotateLinkSmoke(
  annotation: { checkerContaminated: boolean; methodologyNote: string },
  opts: { week?: string; now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<void> {
  await updateWeeklyCounters((weeks, currentWeek) => {
    const target = opts.week ?? currentWeek;
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
