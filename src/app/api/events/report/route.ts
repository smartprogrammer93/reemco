/**
 * REEA-37 — weekly funnel report endpoint (AC-4).
 *
 * GET /api/events/report?days=7
 * Returns { window_days, searches, click_outs, click_out_rate, copies,
 * copy_rate, zero_results, zero_result_rate, top_queries,
 * click_rank_histogram, v1 }
 * over the requested window (default 7 days, capped at the 90-day raw
 * retention). `v1` (REEA-965) carries the R2 relevance/coupon metrics:
 * per-day zero-result rate and first-result CTR (AC-6) plus coupon-hit rate
 * per retailer (AC-7), recomputed from raw events. REEA-233: reads merge the
 * shared-KV blob with this instance's local layer, so the window covers the
 * trailing days across instances, not one warm box.
 *
 * REEA-1251 — security follow-up from REEA-1245 (OWASP API4:2023, unrestricted
 * resource consumption). This public read path had no caller budget and every
 * call re-read and re-parsed the full anonymous event blob (7.5 MB at the
 * review, 1.39 s solo, 14.78 s average at 60 concurrent) on the single Node
 * event loop, slowing every sibling route. Three changes, per the fix spec:
 *  1. the REEA-827 shared fixed window (30/min per caller — the same budget
 *     and REEA-837 wire headers as the sibling /api/metrics/weekly gate) sits
 *     AHEAD of the store reads; a spent caller gets the standard 429 body with
 *     Retry-After and does zero store work;
 *  2. the aggregate is served from the REEA-1251 short-TTL single-flight cache
 *     (lib/report-cache.ts) so repeat reads do not re-parse the blob, and
 *     concurrent misses parse it once; pruning runs at most hourly, after the
 *     response via `after()`, never in front of a caller;
 *  3. `cache-control: no-store` stays on every answer.
 * The payload shape and the window clamping are unchanged.
 */
import { after } from "next/server";
import { MAX_AGE_DAYS, pruneOldEvents } from "@/lib/event-store";
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { claimPruneSlot, getWeeklyReport } from "@/lib/report-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * REEA-1251 — per-caller budget for the funnel report read (30/min).
 *
 * This is a reporting read, not a shopper route, so the shopper routes'
 * 120/min would be pure headroom; 30/min still covers a dashboard refreshing
 * every few seconds while bounding a runaway poller. Same budget and wire
 * shape as /api/metrics/weekly (REEA-1134 F5) so the two sibling reads of the
 * same event blob cannot drift apart.
 */
export const REPORT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

// Same caller key as the sibling gated routes (first X-Forwarded-For hop).
function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

function parseWindowDays(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, MAX_AGE_DAYS);
}

export async function GET(req: Request): Promise<Response> {
  // REEA-1251 — gate ahead of the store reads: a spent caller answers 429
  // without reading the blob or touching the cache.
  const gate = await checkRateLimitShared(
    `events-report:${clientKey(req)}`,
    Date.now(),
    REPORT_RATE_LIMIT,
  );
  if (!gate.allowed) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429, headers: rateLimitHeaders(gate) });
  }

  const days = parseWindowDays(new URL(req.url).searchParams.get("days"));
  const { report, cache } = await getWeeklyReport(days);

  // REEA-1251 — retention housekeeping is off the read path: claim at most one
  // hourly slot and prune after the answer is on the wire. A prune failure is
  // best-effort and must never fail the report (graceful degradation).
  if (claimPruneSlot()) {
    after(() => pruneOldEvents().catch((err) => console.error("event prune failed", err)));
  }

  return Response.json(report, {
    headers: {
      // REEA-1251 — the answer is a live aggregate, never a static catalog;
      // the short TTL is bounded in-process, so no intermediary may keep it.
      "cache-control": "no-store",
      // Observable cache state for the gate/latency verification (hit|miss).
      "x-report-cache": cache,
      ...rateLimitHeaders(gate),
    },
  });
}
