/**
 * REEA-84 W1 T3 — GET /api/collect-jobs/:jobId
 *
 * Polling endpoint: returns the live job snapshot including per-retailer
 * subtask states (pending | collecting | done | failed | timeout) and the
 * offers collected so far (AC2). no-store — always the freshest state.
 */
import { getJob } from "@/lib/collect/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/collect-jobs/[jobId]">,
) {
  const { jobId } = await ctx.params;
  const job = getJob(jobId);
  if (!job) {
    return Response.json({ error: "Unknown collect job" }, { status: 404 });
  }
  return Response.json(job, { headers: { "Cache-Control": "no-store" } });
}
