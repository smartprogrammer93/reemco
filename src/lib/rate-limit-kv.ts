/**
 * REEA-827 — deployment-wide rate-limit budget on the shared KV layer.
 *
 * The REEA-37 `checkRateLimit` is memory-only per process; on Vercel the
 * gated endpoints fan out across Lambda instances, so the documented
 * "120 req/min per caller" budget was really per caller per instance
 * ([REEA-826](/REEA/issues/REEA-826)). This module layers a fixed-window
 * counter over the same shared KV binding the event store (REEA-233) and
 * metrics (REEA-807) ride: one atomic INCR per gated request lands every
 * instance's hit in the SAME per-caller window, so the budget is enforced
 * deployment-wide.
 *
 * Contract mirrors the shared-store pattern:
 *  - Fixed window: the window id (`floor(now / windowMs)`) is part of the KV
 *    key, so a new window is a fresh key with a fresh budget — no per-hit
 *    expiry bookkeeping, and the TTL (window length + 1s) only exists so
 *    spent window keys garbage-collect themselves.
 *  - Graceful degradation: with no KV binding (local dev, tests) or a KV
 *    hiccup (`incr` returns null / throws) the call falls back to the
 *    REEA-37 per-process sliding window — a degraded instance still rate-
 *    limits, it just answers for itself alone. Never a failed request.
 *  - Data minimization: the caller key (raw client IP) is SHA-256-hashed
 *    before it goes to KV, preserving REEA-37's "no PII leaves the process"
 *    property; the namespace (`echo:`, `csp-report:`, …) rides through the
 *    hash so buckets stay independent.
 *  - Rate-limit citizenship: one KV round trip per gated request (plus one
 *    EXPIRE on the first hit of a window) — the same best-effort cost the
 *    event/metrics stores already accept per request.
 *
 * The fixed window is slightly coarser than the memory limiter's sliding
 * window (a caller can burst up to 2x the limit across a window boundary);
 * that is the accepted tradeoff for a single atomic op per request.
 *
 * Server-only module (node:crypto); never import from client code.
 */
import { createHash } from "node:crypto";
import { getSharedKv, type SharedKv } from "@/lib/collect/kv";
import { checkRateLimit, RATE_LIMIT, type RateLimitOptions, type RateLimitResult } from "@/lib/rate-limit";

/** Shared-KV key namespace for rate-limit window counters. */
export const RATE_LIMIT_KV_PREFIX = "ratelimit:";

/** Extra second on the window TTL so the key always outlives its window. */
const TTL_SLACK_S = 1;

export interface SharedRateLimitOptions extends RateLimitOptions {
  /** Injected shared store (tests). undefined resolves `getSharedKv()`. */
  kv?: SharedKv | null;
}

/** Window id for a timestamp — fixed windows are `windowMs` aligned. */
export function windowIdAt(now: number, windowMs: number): number {
  return Math.floor(now / windowMs);
}

/**
 * KV key for one caller-window: hashed caller key + window id. The raw
 * client IP never reaches the shared store.
 */
export function sharedWindowKey(key: string, id: number): string {
  const hashed = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${RATE_LIMIT_KV_PREFIX}${hashed}:${id}`;
}

/**
 * Deployment-wide gate: counts the caller in the shared fixed window when a
 * KV store with atomic INCR is bound, else (and on any KV failure) falls
 * back to the per-process REEA-37 sliding window. Same result shape.
 */
export async function checkRateLimitShared(
  key: string,
  now: number,
  opts: SharedRateLimitOptions = RATE_LIMIT,
): Promise<RateLimitResult> {
  const kv = opts.kv !== undefined ? opts.kv : getSharedKv();
  if (kv?.incr) {
    try {
      const id = windowIdAt(now, opts.windowMs);
      const count = await kv.incr(sharedWindowKey(key, id), Math.ceil(opts.windowMs / 1000) + TTL_SLACK_S);
      if (typeof count === "number" && Number.isFinite(count)) {
        return { allowed: count <= opts.limit, remaining: Math.max(0, opts.limit - count) };
      }
    } catch {
      // KV hiccup — degrade to the local layer below.
    }
  }
  return checkRateLimit(key, now, opts);
}
