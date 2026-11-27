/**
 * REEA-1251 — short-TTL single-flight cache for the weekly funnel report.
 *
 * Security follow-up from REEA-1245 (OWASP API4:2023, unrestricted resource
 * consumption): GET /api/events/report re-read and re-parsed the whole shared
 * event blob (`events:jsonl`, 7,557,726 B at the time of the review) on EVERY
 * call, on the single Node event loop. A solo read measured 1.39 s; a
 * 60-concurrent burst averaged 14.78 s because every call burned the loop on
 * the same parse — latency amplification that every other route (including
 * /results) shared. The route also had no caller budget at all.
 *
 * This module removes the per-call parse without weakening the report:
 *  - the aggregate is cached per `days` window for REPORT_CACHE_TTL_MS (30 s,
 *    the short TTL the fix spec allows), so a repeat read answers from memory
 *    instead of re-reading KV and re-parsing the blob;
 *  - concurrent misses coalesce on ONE in-flight computation (single flight),
 *    so a burst of admitted callers still parses the blob once, not N times;
 *  - retention pruning left the read path: the route claims a prune slot at
 *    most once per REPORT_PRUNE_INTERVAL_MS (1 h) and runs it after the
 *    response through `after()`, so pruning never sits in front of a caller.
 *
 * Fidelity: the cached object is a pure aggregate over events already read, so
 * nothing bundled or hand-written enters the answer (live-data fidelity). It
 * carries the `generated_at` of the computation it came from, so a reader sees
 * its age on the payload; the 30 s TTL is the sanctioned staleness bound for
 * this reporting read (the shopper offer feed does not go through here).
 *
 * Scope: process-local memory. On the self-hosted box that is the one process
 * answering the route; in any multi-instance layout each instance caches its
 * own answer, which still bounds the parse per instance. No KV round trip is
 * added on the read path (rate-limit citizenship).
 *
 * Server-only module; never import from client code.
 */
import { readEvents } from "@/lib/event-store";
import { aggregateWeekly } from "@/lib/report";
import type { WeeklyReport } from "@/lib/report";

/** REEA-1251 — how long one computed aggregate is served from memory. */
export const REPORT_CACHE_TTL_MS = 30_000;

/** REEA-1251 — retention pruning runs at most this often, never per read. */
export const REPORT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface CachedWeeklyReport {
  report: WeeklyReport;
  /** "hit" = served from the TTL cache; "miss" = (re)computed by this call. */
  cache: "hit" | "miss";
}

interface CacheEntry {
  report: WeeklyReport;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<WeeklyReport>>();
let lastPruneAt = Number.NEGATIVE_INFINITY;

/**
 * REEA-1251 — the aggregate for one `days` window, from the TTL cache when it
 * is still fresh, else computed once and shared with every concurrent caller
 * that missed the same window.
 *
 * The cache/in-flight lookups and the in-flight registration happen before the
 * first `await`, so two simultaneous requests cannot both become the leader.
 * A rejected computation is never cached and always clears the in-flight slot,
 * so a transient store failure cannot pin a bad answer for 30 s.
 */
export async function getWeeklyReport(days: number, now = Date.now()): Promise<CachedWeeklyReport> {
  const hit = cache.get(days);
  if (hit && now < hit.expiresAt) return { report: hit.report, cache: "hit" };

  const pending = inFlight.get(days);
  if (pending) return { report: await pending, cache: "miss" };

  const computation = (async () => {
    const events = await readEvents();
    return aggregateWeekly(events, { now, windowDays: days });
  })();
  inFlight.set(days, computation);
  try {
    const report = await computation;
    // Expiry starts at completion so a slow first read does not shorten the
    // served window below REPORT_CACHE_TTL_MS.
    cache.set(days, { report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
    return { report, cache: "miss" };
  } finally {
    inFlight.delete(days);
  }
}

/**
 * REEA-1251 — claim the retention-prune slot for this instant. True at most
 * once per REPORT_PRUNE_INTERVAL_MS; the first read of a process claims it so
 * the pre-existing "prune before aggregating" contract still runs once on a
 * cold box. The caller schedules the prune AFTER the response (`after()`), so
 * the claim is cheap and the parse never blocks a caller.
 */
export function claimPruneSlot(now = Date.now()): boolean {
  if (now - lastPruneAt < REPORT_PRUNE_INTERVAL_MS) return false;
  lastPruneAt = now;
  return true;
}

/** Test helper: drop the cache and make the next prune slot claimable. */
export function resetReportCache(now = Date.now()): void {
  cache.clear();
  inFlight.clear();
  lastPruneAt = now - REPORT_PRUNE_INTERVAL_MS;
}
