/**
 * REEA-277 / REEA-291 AC5 — per-query server-side memoization with a hard
 * 90-second TTL, the app-level layer behind the results-page
 * time-to-first-offer fix.
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
 *  - an entry inside the 90-second window serves immediately,
 *  - past the window the entry is dropped and the caller re-runs the live
 *    fan-out — so a memoized page is aged ≤ 2 min, inside the CEO-approved
 *    60–120 s window (REEA-291 AC5).
 *
 * Identity is the NORMALIZED QUERY STRING ONLY (REEA-291 AC5): case and
 * surrounding whitespace fold together, and no viewer-side signal (country,
 * cookie, language hint) joins the key — the memoized answer is per query,
 * never per shopper profile. The viewer's market/stock selections are a
 * filter over the loaded payload, applied at render time — not part of the
 * collected answer's identity.
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

/** Memoization window (REEA-291 AC5): entries this young serve immediately. */
export const QUERY_CACHE_FRESH_MS = 90_000; // 90 s — CEO-approved 60–120 s window
/** Hard ceiling: older entries are dropped, not served. Age stays ≤ 2 min. */
export const QUERY_CACHE_MAX_AGE_MS = 90_000;
/** Bounded memory: top-200 query set plus headroom, oldest-first eviction. */
export const QUERY_CACHE_MAX_ENTRIES = 250;

export interface QueryCacheHit<T> {
  value: T;
  /** True inside the stale window: serve now, revalidate behind the response.
   *  With the REEA-291 single 90 s window the two windows coincide, so a hit
   *  inside the TTL is always fresh and anything older is already dropped. */
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
 */
export function queryCacheKey(query: string): string {
  return query.trim().toLowerCase();
}
