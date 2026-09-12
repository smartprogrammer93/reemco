/**
 * REEA-807 — lightweight outcome instrumentation: server-side aggregate
 * counters in weekly buckets. No PII, no user identifiers, no query text —
 * the stored schema carries only integer counters and retailer names (the
 * same names the coverage line already renders). No third-party scripts and
 * no client surface: everything here runs server-side (results page `after()`
 * tail, metrics routes, ops scripts).
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
  /** Checked URLs that answered dead (non-2xx/3xx or unreachable). */
  dead: number;
  by_retailer: Record<string, { checked: number; dead: number }>;
}

export interface WeekCounters {
  /** Live searches served (one fan-out page serve = one search). */
  searches: number;
  /** Searches whose converged answer carried zero offers. */
  zero_offer_searches: number;
  /** Offers delivered per retailer (the coverage-line `hits`, summed). */
  offers_by_retailer: Record<string, number>;
  link_smoke: LinkSmokeCounters;
}

export type WeekCountersMap = Record<string, WeekCounters>;

export interface MetricsBlob {
  version: 1;
  weeks: WeekCountersMap;
}

function emptyLinkSmoke(): LinkSmokeCounters {
  return { runs: 0, checked: 0, dead: 0, by_retailer: {} };
}

export function emptyWeek(): WeekCounters {
  return { searches: 0, zero_offer_searches: 0, offers_by_retailer: {}, link_smoke: emptyLinkSmoke() };
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
  return w;
}

/** The serve-time facts of one converged live search, ready to aggregate. */
export interface SearchOutcome {
  zeroOffers: boolean;
  /** Per-retailer delivered-offer counts (the snapshot's coverage notes). */
  offersByRetailer: Record<string, number>;
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
  for (const [merchant, hits] of Object.entries(outcome.offersByRetailer ?? {})) {
    const by = clampCount(hits);
    if (by > 0) bumpRetailer(w.offers_by_retailer, merchant, by);
  }
  return weeks;
}

/** Pure: fold one dead-link smoke run into the weekly buckets. */
export function applyLinkSmoke(
  weeks: WeekCountersMap,
  week: string,
  result: { checked: number; dead: number; byRetailer: Record<string, { checked: number; dead: number }> },
): WeekCountersMap {
  const w = ensureWeek(weeks, week);
  const checked = clampCount(result.checked);
  const dead = Math.min(clampCount(result.dead), checked);
  w.link_smoke.runs += 1;
  w.link_smoke.checked += checked;
  w.link_smoke.dead += dead;
  for (const [merchant, c] of Object.entries(result.byRetailer ?? {}).slice(0, MAX_RETAILERS_PER_WEEK)) {
    const rChecked = clampCount(c?.checked);
    const rDead = Math.min(clampCount(c?.dead), rChecked);
    if (rChecked === 0) continue;
    const name = sanitizeMerchant(merchant);
    if (!name) continue;
    const bucket = w.link_smoke.by_retailer[name] ?? { checked: 0, dead: 0 };
    bucket.checked += rChecked;
    bucket.dead += rDead;
    w.link_smoke.by_retailer[name] = bucket;
  }
  return weeks;
}

/** Pure: map a converged LiveSearchResult onto the aggregate outcome.
 *  Only successful notes count (an error note delivered nothing); the
 *  zero-offer flag reads the product count of the converged snapshot. */
export function searchOutcomeFromSnapshot(snap: {
  products: unknown[];
  notes: { merchant: string; hits: number; error?: string }[];
}): SearchOutcome {
  const offersByRetailer: Record<string, number> = {};
  for (const n of snap.notes ?? []) {
    if (n?.error) continue;
    if (clampCount(n?.hits) > 0) offersByRetailer[n.merchant] = clampCount(n.hits);
  }
  return { zeroOffers: (snap.products?.length ?? 0) === 0, offersByRetailer };
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

/** Read the retained weekly buckets (KV blob when bound, else local file). */
export async function readWeeklyCounters(
  opts: { dir?: string; kv?: SharedKv | null } = {},
): Promise<WeekCountersMap> {
  const kv = sharedKv(opts);
  if (kv) {
    const raw = await kv.get(METRICS_KV_KEY).catch(() => null);
    if (raw !== null) return pruneWeeks(parseBlob(raw).weeks);
    // KV unreachable: fall through to the local layer rather than losing
    // everything (graceful degradation — the local layer still counts).
  }
  return pruneWeeks(readLocal(opts.dir ?? METRICS_DIR).weeks);
}

/** Apply `apply` to the buckets and persist (best-effort). KV-bound stores
 *  read-modify-write the shared blob; unbound stores rewrite the local file. */
export async function updateWeeklyCounters(
  apply: (weeks: WeekCountersMap, week: string) => void,
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<WeekCountersMap> {
  const now = opts.now ?? Date.now();
  const week = isoWeekKey(now);
  const kv = sharedKv(opts);
  let weeks: WeekCountersMap;
  if (kv) {
    const raw = await kv.get(METRICS_KV_KEY).catch(() => null);
    weeks = raw !== null ? parseBlob(raw).weeks : readLocal(opts.dir ?? METRICS_DIR).weeks;
  } else {
    weeks = readLocal(opts.dir ?? METRICS_DIR).weeks;
  }
  apply(weeks, week);
  const pruned = pruneWeeks(weeks);
  const body = JSON.stringify({ version: 1, weeks: pruned } satisfies MetricsBlob);
  if (kv) {
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
  result: { checked: number; dead: number; byRetailer: Record<string, { checked: number; dead: number }> },
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<void> {
  await updateWeeklyCounters((weeks, week) => applyLinkSmoke(weeks, week, result), opts);
}
