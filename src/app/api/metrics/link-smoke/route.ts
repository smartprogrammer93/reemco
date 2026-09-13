/**
 * REEA-807 — dead-link smoke result ingest.
 *
 * POST /api/metrics/link-smoke  { checked, dead, by_retailer }
 *
 * The dead-link smoke script (scripts/dead-link-smoke.mjs) checks a bounded
 * sample of LIVE offer URLs (pulled from this site's own converged results
 * feed — never a bundled catalog) and posts the aggregate outcome here so it
 * lands in the weekly PM snapshot. Server-side aggregate counters only:
 *
 *  - JSON-only, 4 KB payload cap, schema validation with per-field bounds
 *    (same hardening posture as the REEA-37 events route);
 *  - rate limit per caller (REEA-827 shared fixed window when KV is bound,
 *    per-instance otherwise — the REEA-826 semantics; the raw key is hashed
 *    before it leaves the process);
 *  - no cookies, no identifiers, no per-URL or per-query data stored — the
 *    counters keep integer totals and retailer names only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { recordLinkSmoke } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;
/** Smokes are occasional: a tighter window than the events route's 120/min. */
const SMOKE_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

const merchantCountsSchema = z.record(
  z.string().max(40),
  z.object({ checked: z.number().int().min(0).max(500), dead: z.number().int().min(0).max(500) }),
);

const bodySchema = z.object({
  checked: z.number().int().min(0).max(500),
  dead: z.number().int().min(0).max(500),
  by_retailer: merchantCountsSchema,
});

function clientKey(req: NextRequest | Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const gate = await checkRateLimitShared(clientKey(req), Date.now(), SMOKE_RATE_LIMIT);
  if (!gate.allowed) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429, headers: rateLimitHeaders(gate) });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text || "null");
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.map((i) => i.message).slice(0, 5) },
      { status: 400 },
    );
  }
  if (parsed.data.dead > parsed.data.checked) {
    return Response.json({ error: "dead cannot exceed checked" }, { status: 400 });
  }

  try {
    await recordLinkSmoke({
      checked: parsed.data.checked,
      dead: parsed.data.dead,
      byRetailer: parsed.data.by_retailer,
    });
  } catch (err) {
    console.error("metrics store write failed", err);
    return Response.json({ error: "metrics store unavailable" }, { status: 503 });
  }
  return Response.json({ accepted: true }, { status: 202 });
}
