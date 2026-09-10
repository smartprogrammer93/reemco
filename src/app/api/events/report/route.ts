/**
 * REEA-37 — weekly funnel report endpoint (AC-4).
 *
 * GET /api/events/report?days=7
 * Returns { window_days, searches, click_outs, click_out_rate, copies,
 * copy_rate, zero_results, zero_result_rate, top_queries,
 * click_rank_histogram }
 * over the requested window (default 7 days, capped at the 90-day raw
 * retention). Also prunes raw events older than 90 days before aggregating.
 * REEA-233: reads merge the shared-KV blob with this instance's local layer,
 * so the window covers the trailing days across instances, not one warm box.
 */
import type { NextRequest } from "next/server";
import { MAX_AGE_DAYS, pruneOldEvents, readEvents } from "@/lib/event-store";
import { aggregateWeekly } from "@/lib/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseWindowDays(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, MAX_AGE_DAYS);
}

export async function GET(req: NextRequest): Promise<Response> {
  await pruneOldEvents();
  const days = parseWindowDays(req.nextUrl.searchParams.get("days"));
  const events = await readEvents();
  const report = aggregateWeekly(events, { windowDays: days });
  return Response.json(report, {
    headers: { "cache-control": "no-store" },
  });
}
