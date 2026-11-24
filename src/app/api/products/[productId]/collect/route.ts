/**
 * REEA-84 W1 T1 — POST /api/products/:id/collect
 *
 * Creates (or dedupes to) a collection job and returns its id in <300 ms
 * (AC1/AC8). The scrape fan-out runs after the response via `after()` so the
 * job proceeds while the client polls GET /api/collect-jobs/:jobId (T3).
 * When a fresh (<=10 min) completed collection exists it is served directly
 * with mode "cache" — no scrape is triggered (AC5).
 *
 * REEA-1063 — this is the most expensive unauthenticated surface in the app
 * (it starts a live retailer scrape fan-out, inline for ?wait=1) and was the
 * last expensive route without a gate (OWASP API4:2023). It now rides the
 * shared per-caller limiter exactly like csp-report/health: 30 POSTs/min per
 * caller, `force:true` included, denied calls answer 429 with the REEA-837
 * wire headers and do ZERO collection work.
 */
import { after } from "next/server";
import { resolveProductIdentity } from "@/lib/product-identity";
import { runCollection, startCollection } from "@/lib/collect/runner";
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { sanitizeCountry } from "@/lib/country";
import { sanitizeSearchQuery } from "@/lib/search-params";

export const dynamic = "force-dynamic";
// Headroom only — the 25 s overall budget in the runner enforces the 30 s
// user-visible contract (AC7) regardless of platform limits.
export const maxDuration = 60;

/** REEA-1063 — per-caller budget for the expensive collect POST. */
export const COLLECT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

// Same caller key as the sibling gated routes (first X-Forwarded-For hop). On
// the self-hosted box Caddy overwrites the incoming header with the real peer,
// so the first hop is the actual client (REEA-1052 evidence).
function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/products/[productId]/collect">,
) {
  // REEA-1063 — gate ahead of every expensive step (identity resolution, job
  // creation, scrape fan-out): a spent caller answers 429 and does none of it.
  // `force:true` is not a bypass — every POST consumes one slot.
  const gate = await checkRateLimitShared(
    `collect:${clientKey(request)}`,
    Date.now(),
    COLLECT_RATE_LIMIT,
  );
  if (!gate.allowed) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429, headers: rateLimitHeaders(gate) });
  }
  const gateHeaders = rateLimitHeaders(gate);

  const { productId } = await ctx.params;
  const requestUrl = new URL(request.url);
  // REEA-1140 — the client restart must resolve the SAME merged group the
  // product page resolved: carry the results query (and market) through the
  // POST. Without them a repeat collection re-decodes the slug into a
  // different search phrase and starts a job from the wrong offer set.
  const carriedQuery = sanitizeSearchQuery(requestUrl.searchParams.get("q"));
  const country = sanitizeCountry(requestUrl.searchParams.get("c"));
  const product = await resolveProductIdentity(productId, country, carriedQuery);
  if (!product) {
    return Response.json({ error: "Unknown product" }, { status: 404, headers: gateHeaders });
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
  const wait = requestUrl.searchParams.get("wait") === "1";

  if (wait && !servedFromCache && !deduped) {
    const final = await runCollection(job, product);
    return Response.json(final, { headers: { ...gateHeaders, "Cache-Control": "no-store" } });
  }

  if (!servedFromCache && !deduped) {
    // Run the fan-out after the response — POST returns immediately (<300 ms).
    after(() => runCollection(job, product));
  }

  if (wait) {
    // Cache/dedupe hit in wait mode: return the full snapshot synchronously.
    return Response.json(job, { headers: { ...gateHeaders, "Cache-Control": "no-store" } });
  }

  return Response.json(
    {
      jobId: job.jobId,
      status: job.status,
      mode: servedFromCache ? "cache" : job.mode,
      deduped,
      servedFromCache,
    },
    { headers: { ...gateHeaders, "Cache-Control": "no-store" } },
  );
}
