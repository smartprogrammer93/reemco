/**
 * REEA-84 W1 T1 — POST /api/products/:id/collect
 *
 * Creates (or dedupes to) a collection job and returns its id in <300 ms
 * (AC1/AC8). The scrape fan-out runs after the response via `after()` so the
 * job proceeds while the client polls GET /api/collect-jobs/:jobId (T3).
 * When a fresh (<=10 min) completed collection exists it is served directly
 * with mode "cache" — no scrape is triggered (AC5).
 */
import { after } from "next/server";
import { resolveProductIdentity } from "@/lib/feed";
import { runCollection, startCollection } from "@/lib/collect/runner";

export const dynamic = "force-dynamic";
// Headroom only — the 25 s overall budget in the runner enforces the 30 s
// user-visible contract (AC7) regardless of platform limits.
export const maxDuration = 60;

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/products/[productId]/collect">,
) {
  const { productId } = await ctx.params;
  const product = await resolveProductIdentity(productId);
  if (!product) {
    return Response.json({ error: "Unknown product" }, { status: 404 });
  }

  let force = false;
  try {
    const body = (await request.json()) as { force?: boolean } | null;
    force = body?.force === true;
  } catch {
    /* empty body is fine */
  }

  const { job, deduped, servedFromCache } = await startCollection(product, { force });

  // ?wait=1 — synchronous mode (REEA-85 Vercel finding): on Vercel each API
  // route is a separate serverless function, so the polling GET frequently
  // lands on an instance that cannot see the job created by the POST function
  // (no shared memory or /tmp across functions). The client falls back to this
  // mode when polling misses; the run happens inside this invocation and the
  // terminal snapshot — with real per-retailer subtask states (AC2) — is
  // returned directly. The 25s overall budget keeps this inside maxDuration.
  const wait = new URL(request.url).searchParams.get("wait") === "1";

  if (wait && !servedFromCache && !deduped) {
    const final = await runCollection(job, product);
    return Response.json(final, { headers: { "Cache-Control": "no-store" } });
  }

  if (!servedFromCache && !deduped) {
    // Run the fan-out after the response — POST returns immediately (<300 ms).
    after(() => runCollection(job, product));
  }

  if (wait) {
    // Cache/dedupe hit in wait mode: return the full snapshot synchronously.
    return Response.json(job, { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json(
    {
      jobId: job.jobId,
      status: job.status,
      mode: servedFromCache ? "cache" : job.mode,
      deduped,
      servedFromCache,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
