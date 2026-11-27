/**
 * REEA-1237 (PM scope extension, v5 improvement read) — top query terms.
 *
 * The weekly counters name the zero-offer and filtered-empty POPULATION but
 * not the terms that carry it, so the Pareto fix (repair the ~20 terms that
 * carry demand) cannot be targeted. This store keeps, per ISO week, an
 * aggregate map of normalized query terms to three integers: shopper serves
 * for the term, how many of those ended with zero offers, and how many were
 * the false-empty behind an active filter. Nothing else is kept — the term
 * string and three counters, no user id, no session id, no per-serve row
 * (Data Minimization; the PM's "aggregate {term, count} rows only").
 *
 * Normalization is case-fold + whitespace collapse + control-char strip,
 * capped at 80 characters. NO stemming: Arabic and Latin terms stay as the
 * shopper typed them (minus case/space noise) and remain comparable.
 *
 * Storage: one JSON blob per week under `metrics:queries:v1:<isoWeek>` with
 * the metrics retention TTL, plus a local-file layer for an unbound or
 * degraded store. Each write is a read-modify-write on one small blob
 * (<= MAX_STORED_QUERY_TERMS terms). A concurrent serve can lose an
 * increment: acceptable for a Pareto read (this is instrumentation, not a
 * decision counter), and the alternative — atomic per-term keys — would put
 * thousands of keys into the weekly keyspace the metrics read enumerates with
 * one `KEYS` call. Every fold lands in exactly ONE layer (KV when its write
 * succeeds, local when it does not), so the read can sum the two layers
 * without double counting.
 *
 * Server-only (node:fs); never import from client code.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSharedKv, type SharedKv } from "@/lib/collect/kv";
import { isoWeekKey, METRICS_DIR, RETENTION_WEEKS } from "@/lib/metrics";

/** Published rows per week; the PM's top-200 Pareto cap. */
export const MAX_QUERY_TERMS = 200;

/**
 * Terms kept in the store per week. Deliberately above the published cap: if
 * the stored map were capped at 200, a NEW term could never enter a saturated
 * week — it would be re-evicted at count 1 on every serve and could never
 * accumulate, freezing the Pareto at whichever 200 terms arrived first. The
 * extra headroom lets a term that trends later in the week compete for a
 * published slot; the payload still caps at 200. 1000 terms is ~100 KB of
 * blob, written once per serve behind the response (after() tail).
 */
export const MAX_STORED_QUERY_TERMS = 1_000;

/** Longest stored term, in characters. */
export const MAX_QUERY_TERM_LENGTH = 80;

/** Shared-KV key prefix; one blob per ISO week. */
export const QUERY_TERMS_KV_PREFIX = "metrics:queries:v1";

/** Outlive the metrics retention window a little (same posture as REEA-1035). */
export const QUERY_TERMS_KV_TTL_S = (RETENTION_WEEKS * 7 + 7) * 24 * 60 * 60;

export interface QueryTermCounters {
  /** Shopper serves for this term (bot serves are not recorded). */
  count: number;
  /** Of those serves, how many ended with zero offers. */
  zero_offer: number;
  /** Of those serves, how many were false-empty behind an active filter. */
  filtered_empty: number;
}

export type WeekQueryTerms = Record<string, QueryTermCounters>;
export type QueryTermsMap = Record<string, WeekQueryTerms>;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Normalize one shopper query into the stored term: case-folded, internal
 * whitespace collapsed, control characters stripped, trimmed, capped. Returns
 * null for a term that is empty after normalization. Deliberately no stemming
 * (the PM's comparability requirement): only noise is removed.
 */
export function normalizeQueryTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!collapsed) return null;
  return collapsed.length > MAX_QUERY_TERM_LENGTH
    ? collapsed.slice(0, MAX_QUERY_TERM_LENGTH).trim()
    : collapsed;
}

function emptyCounters(): QueryTermCounters {
  return { count: 0, zero_offer: 0, filtered_empty: 0 };
}

function clamp(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Keep the MAX_STORED_QUERY_TERMS highest-count terms; ties break by
 * zero-offer count, then by term. `admit` (the term just folded) wins a
 * boundary tie: at saturation a NEW count-1 term displaces an existing count-1
 * tail term instead of being re-evicted at count 1 forever, so a term that
 * starts trending mid-week can still accumulate and reach the published 200.
 * A new term whose count is below every stored term is still dropped — that is
 * the honest long tail, not demand.
 */
function capTerms(map: WeekQueryTerms, admit?: string): void {
  const entries = Object.entries(map);
  if (entries.length <= MAX_STORED_QUERY_TERMS) return;
  entries.sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (b[1].zero_offer !== a[1].zero_offer) return b[1].zero_offer - a[1].zero_offer;
    if (admit !== undefined) {
      if (a[0] === admit) return -1;
      if (b[0] === admit) return 1;
    }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const kept = entries.slice(0, MAX_STORED_QUERY_TERMS);
  for (const key of Object.keys(map)) delete map[key];
  for (const [term, counters] of kept) map[term] = counters;
}

/**
 * Pure: fold one shopper serve into the week's term map. `count` is the
 * denominator for the term; the two flags are mutually independent marks
 * (a filtered-empty serve can also be zero-offer).
 */
export function foldQueryTerm(
  map: WeekQueryTerms,
  term: string,
  flags: { zeroOffer?: boolean; filteredEmpty?: boolean } = {},
): void {
  const c = map[term] ?? emptyCounters();
  c.count += 1;
  if (flags.zeroOffer === true) c.zero_offer += 1;
  if (flags.filteredEmpty === true) c.filtered_empty += 1;
  map[term] = c;
  capTerms(map, term);
}

/**
 * Pure: the published shape — highest-count terms first, capped, with the
 * two dead-end marks carried per term. No per-serve data, no identifiers.
 */
export function topQueryTerms(
  map: WeekQueryTerms,
  limit = MAX_QUERY_TERMS,
): { term: string; count: number; zero_offer: number; filtered_empty: number }[] {
  const capped = Math.max(0, Math.min(limit, MAX_QUERY_TERMS));
  return Object.entries(map)
    .sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      if (b[1].zero_offer !== a[1].zero_offer) return b[1].zero_offer - a[1].zero_offer;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, capped)
    .map(([term, c]) => ({
      term,
      count: c.count,
      zero_offer: c.zero_offer,
      filtered_empty: c.filtered_empty,
    }));
}

function parseWeekTerms(raw: string | null): WeekQueryTerms {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: WeekQueryTerms = {};
    for (const [term, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const count = clamp(v.count);
      if (count === 0) continue;
      out[term] = {
        count,
        zero_offer: Math.min(clamp(v.zero_offer), count),
        filtered_empty: Math.min(clamp(v.filtered_empty), count),
      };
    }
    // A corrupted/oversized blob can never inflate a week's storage.
    capTerms(out);
    return out;
  } catch {
    return {};
  }
}

function termsFile(dir = METRICS_DIR): string {
  return join(dir, "query-terms.json");
}

function readLocalTerms(dir = METRICS_DIR): QueryTermsMap {
  try {
    const parsed = JSON.parse(readFileSync(termsFile(dir), "utf8")) as { weeks?: unknown };
    const weeks = parsed?.weeks;
    if (!weeks || typeof weeks !== "object" || Array.isArray(weeks)) return {};
    const out: QueryTermsMap = {};
    for (const [week, map] of Object.entries(weeks as Record<string, unknown>)) {
      out[week] = parseWeekTerms(JSON.stringify(map));
    }
    return out;
  } catch {
    return {};
  }
}

function writeLocalTerms(dir: string, weeks: QueryTermsMap): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = termsFile(dir);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ weeks }));
    renameSync(tmp, file);
  } catch {
    /* best-effort — same posture as the metrics store */
  }
}

function pruneTermWeeks(weeks: QueryTermsMap): QueryTermsMap {
  const keys = Object.keys(weeks).sort();
  const out: QueryTermsMap = {};
  for (const k of keys.slice(-RETENTION_WEEKS)) out[k] = weeks[k];
  return out;
}

function sharedKv(opts: { kv?: SharedKv | null } = {}): SharedKv | null {
  if (opts.kv !== undefined) return opts.kv;
  return getSharedKv();
}

/**
 * Record one shopper serve's term. Callers MUST gate bot/health-check serves
 * out (the shared UA predicate): a QA probe's "sony" would otherwise dominate
 * the Pareto. Best-effort: never throws into the request path.
 */
export async function recordQueryTerm(
  query: string,
  flags: { zeroOffer?: boolean; filteredEmpty?: boolean } = {},
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<void> {
  const term = normalizeQueryTerm(query);
  if (!term) return;
  const now = opts.now ?? Date.now();
  const week = isoWeekKey(now);
  const kv = sharedKv(opts);
  if (kv) {
    const key = `${QUERY_TERMS_KV_PREFIX}:${week}`;
    let current: WeekQueryTerms | null = null;
    try {
      current = parseWeekTerms(await kv.get(key));
    } catch {
      current = null;
    }
    if (current) {
      foldQueryTerm(current, term, flags);
      try {
        if (await kv.set(key, JSON.stringify(current), QUERY_TERMS_KV_TTL_S)) return;
      } catch {
        /* fall through to the local layer */
      }
    }
  }
  const dir = opts.dir ?? METRICS_DIR;
  // readLocalTerms returns the WEEK MAP itself (the file's `weeks` object),
  // not the wrapper — index it directly.
  const weeks = readLocalTerms(dir);
  const map: WeekQueryTerms = weeks[week] ?? {};
  foldQueryTerm(map, term, flags);
  weeks[week] = map;
  writeLocalTerms(dir, pruneTermWeeks(weeks));
}

/**
 * Read the retained per-week term maps. KV is the shared layer; the local
 * layer is summed on top because a fold whose KV write failed landed only
 * there (each fold lands in exactly one layer, so summing cannot double
 * count). Without `keys`/`mget`, the trailing retention window is read one
 * key at a time — bounded (26 gets) and only on the PM read cadence.
 */
export async function readQueryTerms(opts: {
  now?: number;
  dir?: string;
  kv?: SharedKv | null;
} = {}): Promise<{ weeks: QueryTermsMap; source: "kv" | "local" }> {
  const kv = sharedKv(opts);
  const local = pruneTermWeeks(readLocalTerms(opts.dir ?? METRICS_DIR));
  const merge = (weeks: QueryTermsMap): QueryTermsMap => {
    for (const [week, map] of Object.entries(local)) {
      const dst = weeks[week] ?? (weeks[week] = {});
      for (const [term, c] of Object.entries(map)) {
        const cur = dst[term] ?? emptyCounters();
        cur.count += c.count;
        cur.zero_offer += c.zero_offer;
        cur.filtered_empty += c.filtered_empty;
        dst[term] = cur;
      }
      capTerms(dst);
    }
    return pruneTermWeeks(weeks);
  };
  if (kv) {
    if (typeof kv.keys === "function" && typeof kv.mget === "function") {
      try {
        const names = await kv.keys(`${QUERY_TERMS_KV_PREFIX}:*`);
        if (names) {
          const values = names.length > 0 ? await kv.mget(names) : [];
          // mget returns null when the batch read was unreachable: do NOT
          // read that as an empty keyspace (that would silently drop a whole
          // week of terms) — fall through to the per-week reads instead.
          if (values !== null) {
            const weeks: QueryTermsMap = {};
            names.forEach((key, i) => {
              const week = key.slice(QUERY_TERMS_KV_PREFIX.length + 1);
              if (!week) return;
              weeks[week] = parseWeekTerms(values[i] ?? null);
            });
            return { weeks: merge(weeks), source: "kv" };
          }
        }
      } catch {
        /* fall through to per-week reads */
      }
    }
    const now = opts.now ?? Date.now();
    const weeks: QueryTermsMap = {};
    let answered = false;
    for (let i = 0; i < RETENTION_WEEKS; i++) {
      const week = isoWeekKey(now - i * 7 * 24 * 60 * 60 * 1000);
      try {
        const raw = await kv.get(`${QUERY_TERMS_KV_PREFIX}:${week}`);
        if (raw !== null) answered = true;
        weeks[week] = parseWeekTerms(raw);
      } catch {
        /* one failed week degrades to empty, not to a failed read */
      }
    }
    if (answered) return { weeks: merge(weeks), source: "kv" };
  }
  return { weeks: local, source: "local" };
}
