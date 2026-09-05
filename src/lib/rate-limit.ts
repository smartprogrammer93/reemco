/**
 * REEA-37 — in-memory rate limiter for the ingestion endpoint (AC-6).
 *
 * Sliding-window counter keyed by caller (hashed client IP). Memory-only:
 * the key is never persisted and never written to the event store, so no
 * PII leaves the process.
 */

interface RateLimitOptions {
  limit: number; // max requests per window
  windowMs: number;
}

export const RATE_LIMIT: RateLimitOptions = { limit: 120, windowMs: 60_000 };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

const buckets = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  now: number,
  opts: RateLimitOptions = RATE_LIMIT,
  store: Map<string, number[]> = buckets,
): RateLimitResult {
  const hits = (store.get(key) ?? []).filter((t) => now - t < opts.windowMs);
  if (hits.length >= opts.limit) {
    store.set(key, hits);
    return { allowed: false, remaining: 0 };
  }
  hits.push(now);
  store.set(key, hits);
  if (store.size > 10_000) {
    // Bound memory: drop stale buckets on overflow.
    for (const [k, v] of store) {
      if (v.every((t) => now - t >= opts.windowMs)) store.delete(k);
    }
  }
  return { allowed: true, remaining: opts.limit - hits.length };
}

/** Test helper: reset the shared bucket store. */
export function resetRateLimiter(store: Map<string, number[]> = buckets): void {
  store.clear();
}
