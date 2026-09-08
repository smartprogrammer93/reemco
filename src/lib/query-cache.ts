/**
 * REEA-277 — per-query short-TTL response cache with stale-while-revalidate,
 * the app-level layer behind the results-page time-to-first-offer fix.
 *
 * The results fan-out is slowest-at-gated: the first offer paints when the
 * whole round-one set has answered (~4 s cold on the deployed edge). Repeat
 * queries of the same shopper session do not need a second full fan-out —
 * they need the LAST live answer, immediately, plus a bounded refresh behind
 * it. That is what this cache is:
 *
 *  - it ONLY holds responses produced by a live per-query fan-out (never a
 *    bundled/static catalog — the REEA-95 realtime policy is untouched; an
 *    entry is written by the collection code right after its real fetch),
 *  - a fresh entry (≤ QUERY_CACHE_FRESH_MS) serves immediately,
 *  - inside the stale window the entry still serves immediately AND the
 *    caller is told to revalidate behind the response (SWR),
 *  - past QUERY_CACHE_MAX_AGE_MS the entry is dropped and the caller re-runs
 *    the live fan-out blocking — so a served page is never older than the
 *    max age (AC-3: TTL ≤ 15 min; this window is 10 min, matching the
 *    CACHE_TTL_MS labeled-repeat ceiling in collect/types.ts).
 *
 * Per-offer provenance survives the cache untouched: entries store the exact
 * LiveSearchResult the live run produced, scrapedAt included, so freshness
 * chips keep showing the TRUE collection time of the offers on screen — an
 * entry five minutes old renders "updated 5m ago", not "just now".
 *
 * Scope note: this mirrors the per-instance discoveryCache in
 * collect/live-search.ts (REEA-141) — a bounded per-instance Map. On Vercel a
 * warm instance repeats its own queries quickly (that is exactly the AC-2
 * "repeat identical queries within 5 min" case); a cold instance simply runs
 * the live path. Nothing is persisted or bundled.
 */

/** Entries younger than this serve with no revalidation. */
export const QUERY_CACHE_FRESH_MS = 120_000; // 2 min
/** Hard ceiling: older entries are dropped, not served (≤ 15 min, AC-3). */
export const QUERY_CACHE_MAX_AGE_MS = 600_000; // 10 min — repeats within 5 min always HIT (AC-2).
/** Bounded memory: top-200 query set plus headroom, oldest-first eviction. */
export const QUERY_CACHE_MAX_ENTRIES = 250;

export interface QueryCacheHit<T> {
  value: T;
  /** True inside the stale window: serve now, revalidate behind the response. */
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
 * Cache key for one query view. Country scoping changes WHICH adapters answer
 * (REEA-170), so it is part of the identity; case/whitespace is folded —
 * relevance already treats "iPhone" and "iphone" as the same query.
 */
export function queryCacheKey(query: string, country: string | null): string {
  return `${country ?? "*"}|${query.trim().toLowerCase()}`;
}
