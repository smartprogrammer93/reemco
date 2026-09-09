/**
 * REEA-277 / REEA-291 AC5 — per-query server-side memoization: a 90-second
 * fresh window plus a stale-while-revalidate ceiling, the app-level layer
 * behind the results-page time-to-first-offer fix.
 *
 * The results fan-out is slowest-at-gated: the first offer paints when the
 * round-one set has answered (~4 s cold on the deployed edge). A repeat of
 * the SAME normalized query inside the window does not need a second full
 * fan-out — it needs the LAST live answer, immediately. That is what this
 * cache is:
 *
 *  - it ONLY holds responses produced by a live per-query fan-out (never a
 *    bundled/static catalog — the REEA-95 realtime policy is untouched; an
 *    entry is written by the collection code right after its real fetch),
 *  - an entry inside the fresh window serves immediately, no revalidation —
 *    the REEA-291 AC5 band (CEO-approved 60–120 s) sets this window at 90 s,
 *  - between the fresh window and the ceiling the entry STILL serves as the
 *    first flush while the live fan-out re-runs behind the response
 *    (stale-while-revalidate): REEA-277 AC-2's repeat-within-5-minutes
 *    queries always get their HIT, honestly aged,
 *  - past the ceiling the entry is dropped and the caller re-runs the live
 *    fan-out blocking — served age never exceeds 5 min, inside the ≤ 15 min
 *    budget (REEA-277 AC-3).
 *
 * Identity is the NORMALIZED QUERY STRING (REEA-291 AC5): case and
 * surrounding whitespace fold together, and cookie/language hints never
 * fork the memo — the stock toggle filters the loaded payload at render
 * time. The ONE exception is the country selection, which scopes the live
 * fan-out itself (REEA-170: COLLECTORS are filtered to the adapters tagged
 * for the selection), so when a caller passes one it joins the key and
 * each scoped view keeps its own honestly-stamped answer.
 *
 * Per-offer provenance survives the memo untouched: entries store the exact
 * LiveSearchResult the live run produced, scrapedAt included, so the
 * freshness chip keeps showing the TRUE collection time of the offers on
 * screen — an entry 80 seconds old renders aged accordingly, never
 * "just now". Age is always disclosed.
 *
 * Scope note: this mirrors the per-instance discoveryCache in
 * collect/live-search.ts (REEA-141) — a bounded per-instance Map. On Vercel a
 * warm instance repeats its own queries quickly (that is exactly the AC5
 * "repeat identical query inside the window" case); a cold instance simply
 * runs the live path. Nothing is persisted or bundled.
 */

/** Memoization window (REEA-291 AC5): entries this young serve immediately.
 *  REEA-439 tightened it to the 30–60 s band so the whole repeat path
 *  (shared edge entry + this memo) stays under ~60 s of served age. */
export const QUERY_CACHE_FRESH_MS = 60_000; // 60 s — top of the REEA-439 band
/** Stale-serving ceiling (REEA-277 AC-2/AC-3): repeats inside 5 min HIT with
 *  SWR; older entries are dropped and re-collected live (≤ 15 min budget). */
export const QUERY_CACHE_MAX_AGE_MS = 300_000;
/** Bounded memory: top-200 query set plus headroom, oldest-first eviction. */
export const QUERY_CACHE_MAX_ENTRIES = 250;

/**
 * REEA-291 AC4 — the explicit Refresh action is the ONE path that must always
 * re-run the live collection (and so update the collection timestamps), even
 * inside the AC5 fresh window. It rides to the server as a one-shot cookie:
 * `router.refresh()` re-issues the exact same RSC request as the last render,
 * so the flag has to travel inside the request itself — and request-time
 * cookie reads are already the established channel on this route (REEA-280
 * preference hints). Ten seconds of max-age covers the hop it rides; the
 * signal is consumed by that single render and expires by itself.
 */
export const REFRESH_COOKIE = "rc_refresh";

/** Client side of the Refresh signal: stamp the one-shot flag, then refresh. */
export function markLiveRefresh(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${REFRESH_COOKIE}=1; path=/; max-age=10; SameSite=Lax`;
}

/** Server side: is this request an explicit Refresh? */
export function isRefreshSignal(value: string | undefined | null): boolean {
  return value === "1";
}

/** Param carrying the one-shot bypass stamp of a Refresh request (REEA-439). */
export const REFRESH_BYPASS_PARAM = "_r";

/**
 * REEA-439 — the client half of the Refresh bypass. The shared bounded window
 * (next.config headers) answers repeats from the LAST live render, so an
 * explicit Refresh must not take that answer: its request rides a UNIQUE URL
 * (`_r` stamp), and a unique URL is a guaranteed miss on the shared entry —
 * the live fan-out re-runs and the converged write-through moves scrapedAt.
 * Pure helper so the rule stays testable: keeps every other param, replaces a
 * previous bypass stamp instead of stacking them.
 */
export function withRefreshBypass(href: string, stamp: number): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const base = hashAt === -1 ? href : href.slice(0, hashAt);
  const qAt = base.indexOf("?");
  const path = qAt === -1 ? base : base.slice(0, qAt);
  const params = new URLSearchParams(qAt === -1 ? "" : base.slice(qAt + 1));
  params.set(REFRESH_BYPASS_PARAM, String(stamp));
  return `${path}?${params.toString()}${hash}`;
}

export interface QueryCacheHit<T> {
  value: T;
  /** True between the fresh window and the ceiling: serve the last live
   *  answer now AND re-run the fan-out behind the response (SWR). Past the
   *  ceiling there is no hit at all — read returns null and the caller
   *  collects live. */
  stale: boolean;
}

export interface QueryCache {
  /** Entry for the key, or null on miss/expiry. Never throws. */
  read<T>(key: string): QueryCacheHit<T> | null;
  /** Store a freshly fetched value; evicts the oldest entry when full. */
  write<T>(key: string, value: T): void;
  /** Distinct entries currently held (test/diagnostics support). */
  size(): number;
  /** Test support: make cache counts deterministic across test cases. */
  reset(): void;
}

interface Entry {
  value: unknown;
  writtenAt: number;
}

/**
 * Create an independent cache instance. The `now` clock is injectable so the
 * fresh/stale windows are testable without timers.
 */
export function createQueryCache(now: () => number = () => Date.now()): QueryCache {
  const map = new Map<string, Entry>();

  return {
    read<T>(key: string): QueryCacheHit<T> | null {
      const hit = map.get(key);
      if (!hit) return null;
      const age = now() - hit.writtenAt;
      if (age > QUERY_CACHE_MAX_AGE_MS) {
        map.delete(key); // past the ceiling: the next caller re-collects live
        return null;
      }
      return { value: hit.value as T, stale: age > QUERY_CACHE_FRESH_MS };
    },
    write<T>(key: string, value: T): void {
      // Oldest-first eviction keeps the map bounded without a sweeper; the
      // read path already expires entries past the ceiling.
      if (!map.has(key) && map.size >= QUERY_CACHE_MAX_ENTRIES) {
        let oldestKey = "";
        let oldest = Infinity;
        for (const [k, e] of map) {
          if (e.writtenAt < oldest) {
            oldest = e.writtenAt;
            oldestKey = k;
          }
        }
        if (oldestKey) map.delete(oldestKey);
      }
      map.set(key, { value, writtenAt: now() });
    },
    size(): number {
      return map.size;
    },
    reset(): void {
      map.clear();
    },
  };
}

/** The shared instance used by the production (default-fetch) path. */
export const defaultQueryCache = createQueryCache();

/**
 * Cache key for one query view: the NORMALIZED QUERY STRING ONLY
 * (REEA-291 AC5). Case/whitespace is folded — relevance already treats
 * "iPhone" and "iphone" as the same query — and nothing viewer-side joins
 * the identity: the country/stock selections filter the already-loaded
 * payload at render time (ResultsClient), so one live answer per query
 * serves every shopper. Market preferences must not fork the memo.
 *
 * Cache-busting path (QA REEA-411, documented per the handoff options): extra
 * request params — `cb=…` busters, sort/toggle flags — intentionally do NOT
 * join the identity. They only filter the already-loaded answer at render
 * time, and unique-per-request busters would fork the memo and re-run the
 * full fan-out on every hit (hostile to the retailers' endpoints). The bust
 * lever is the explicit Refresh action: the one-shot `rc_refresh` cookie
 * (REEA-291 AC4) re-collects live even inside the fresh window, so the
 * freshness stamp moves on demand. Otherwise the entry ages honestly — fresh
 * window, then stale-while-revalidate, then ceiling expiry. Curl repro for a
 * cold render of one query: `curl -b 'rc_refresh=1' <same-url>`.
 */
export function queryCacheKey(query: string, country?: string | null): string {
  const folded = query.trim().toLowerCase();
  // Country scopes the LIVE fan-out itself (REEA-170 — COLLECTORS are
  // filtered to the adapters tagged for the selection), so the collected
  // payload really differs per selection and its identity must too. Callers
  // without a selection keep the plain query-only key.
  return country ? `${country}|${folded}` : folded;
}
