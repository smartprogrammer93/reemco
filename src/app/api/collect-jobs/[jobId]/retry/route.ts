/**
 * REEA-84 W1 T6 — POST /api/collect-jobs/:jobId/retry
 *
 * Per-retailer retry: body { retailer }. Re-runs only that retailer's scrape
 * on a terminal job and re-evaluates job status. The client resumes polling
 * GET /api/collect-jobs/:jobId for the updated snapshot.
 */
import { resolveProductIdentity } from "@/lib/product-identity";
import { retryRetailer } from "@/lib/collect/runner";
import { getJob } from "@/lib/collect/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/collect-jobs/[jobId]/retry">,
) {
  const { jobId } = await ctx.params;
  const job = await getJob(jobId);
  if (!job) {
    return Response.json({ error: "Unknown collect job" }, { status: 404 });
  }
  if (job.status === "collecting") {
    return Response.json({ error: "Job still in progress" }, { status: 409 });
  }

  let retailer: string | undefined;
  try {
    const body = (await request.json()) as { retailer?: string } | null;
    retailer = body?.retailer;
  } catch {
    /* handled below */
  }
  if (!retailer) {
    return Response.json({ error: "retailer is required" }, { status: 400 });
  }

  const product = await resolveProductIdentity(job.productId);
  if (!product) {
    return Response.json({ error: "Unknown product" }, { status: 404 });
  }

  const updated = await retryRetailer(job, product, retailer);
  if (!updated) {
    return Response.json(
      { error: `No retailer "${retailer}" on this job` },
      { status: 400 },
    );
  }

  // Retailer retries run inline (single fetch, <=20 s bounded) so the response
  // can carry the fresh snapshot directly; no follow-up polling round-trip needed.
  return Response.json(updated, { headers: { "Cache-Control": "no-store" } });
}
