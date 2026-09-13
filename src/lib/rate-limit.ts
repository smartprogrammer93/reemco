/**
 * REEA-37 — in-memory rate limiter for the ingestion endpoint (AC-6).
 *
 * Sliding-window counter keyed by caller (hashed client IP). Memory-only:
 * the key is never persisted and never written to the event store, so no
 * PII leaves the process.
 *
 * REEA-826 — deployment semantics: the bucket store is per PROCESS. On
 * Vercel, requests fan out across serverless instances (each with its own
 * memory), so the enforced budget is `limit` per caller per INSTANCE, not
 * per deployment — the effective abuse ceiling scales with instance count.
 * The in-memory layer is cheap same-instance flood protection (layer 1);
 * a deployment-wide budget requires the shared-KV counter (REEA-826
 * follow-up). Never document the number below as a per-caller deployment
 * budget without that qualifier.
 *
 * REEA-827 — the gated routes now sit behind `checkRateLimitShared`
 * (lib/rate-limit-kv.ts), which layers a deployment-wide fixed-window
 * counter on the shared KV and falls back to THIS limiter when no store is
 * bound or the store hiccups.
 */

/** Exported for lib/rate-limit-kv.ts: SharedRateLimitOptions extends this
 *  (REEA-827 left the interface module-local, failing tsc / next build). */
export interface RateLimitOptions {
  limit: number; // max requests per window
  windowMs: number;
}

export const RATE_LIMIT: RateLimitOptions = { limit: 120, windowMs: 60_000 };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** The enforced per-caller budget — surfaced on the wire via rateLimitHeaders. */
  limit: number;
  /** ms until the caller's budget resets; set whenever a call is denied. */
  retryAfterMs?: number;
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
    // Sliding window: the budget frees up when the OLDEST retained hit ages out.
    return { allowed: false, remaining: 0, limit: opts.limit, retryAfterMs: Math.max(1, hits[0] + opts.windowMs - now) };
  }
  hits.push(now);
  store.set(key, hits);
  if (store.size > 10_000) {
    // Bound memory: drop stale buckets on overflow.
    for (const [k, v] of store) {
      if (v.every((t) => now - t >= opts.windowMs)) store.delete(k);
    }
  }
  return { allowed: true, remaining: opts.limit - hits.length, limit: opts.limit };
}

/**
 * Wire shape for the rate-limit gate (REEA-837): `X-RateLimit-Limit` /
 * `X-RateLimit-Remaining` on every gated response and `Retry-After` (whole
 * seconds) on a denial — QA's 2026-09-13 echo verification tripped at the
 * limit but could not see the budget from the outside.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
  };
  if (!result.allowed && result.retryAfterMs !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
  }
  return headers;
}

/** Test helper: reset the shared bucket store. */
export function resetRateLimiter(store: Map<string, number[]> = buckets): void {
  store.clear();
}
