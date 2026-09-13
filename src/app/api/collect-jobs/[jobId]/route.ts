/**
 * REEA-84 W1 T3 — GET /api/collect-jobs/:jobId
 *
 * Polling endpoint: returns the live job snapshot including per-retailer
 * subtask states (pending | collecting | done | failed | timeout) and the
 * offers collected so far (AC2). no-store — always the freshest state.
 * REEA-92: snapshots live in the shared KV store, so any instance answering
 * this poll sees the job created by another instance's POST.
 */
import { getJob } from "@/lib/collect/store";
import { reapStaleCollectingJob } from "@/lib/collect/runner";
import { isStaleCollectingJob } from "@/lib/collect/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/collect-jobs/[jobId]">,
) {
  const { jobId } = await ctx.params;
  const job = await getJob(jobId);
  if (!job) {
    return Response.json({ error: "Unknown collect job" }, { status: 404 });
  }
  // REEA-870: a "collecting" job older than INFLIGHT_STALE_MS has no living
  // runner — its invocation died before the tail finalize. Serve a reaped
  // terminal snapshot instead of answering "collecting" forever, so a client
  // attached to an orphaned job (e.g. a jobId served from a page render that
  // deduped onto the dead run) always exits its spinner within a bounded time.
  const served = isStaleCollectingJob(job) ? await reapStaleCollectingJob(job) : job;
  return Response.json(served, { headers: { "Cache-Control": "no-store" } });
}
