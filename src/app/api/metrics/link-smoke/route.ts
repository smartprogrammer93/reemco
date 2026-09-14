/**
 * REEA-807 — dead-link smoke result ingest.
 *
 * POST /api/metrics/link-smoke
 *   { checked, dead, challenge?, by_retailer, week?, annotation? }
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
 *
 * REEA-935 — the payload carries the per-outcome counts (checked splits into
 * ok + dead + challenge; ok is derived server-side) and, for the one-shot
 * W37 methodology annotation, an ops-only `week` + `annotation` pair:
 * annotation-only posts stamp the record without bumping any counter, and a
 * past week is accepted only in strict ISO-week shape so the write path can
 * never wander outside the retention window's key format.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { annotateLinkSmoke, recordLinkSmoke } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;
/** Smokes are occasional: a tighter window than the events route's 120/min. */
const SMOKE_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

const merchantCountsSchema = z.record(
  z.string().max(40),
  z.object({
    checked: z.number().int().min(0).max(500),
    dead: z.number().int().min(0).max(500),
    challenge: z.number().int().min(0).max(500).optional(),
  }),
);

const bodySchema = z.object({
  checked: z.number().int().min(0).max(500),
  dead: z.number().int().min(0).max(500),
  challenge: z.number().int().min(0).max(500).optional(),
  by_retailer: merchantCountsSchema,
  /** Ops-only (REEA-934 Change 4): stamp the annotation on this ISO week. */
  week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
  annotation: z
    .object({
      checkerContaminated: z.boolean(),
      methodologyNote: z.string().min(1).max(500),
    })
    .optional(),
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
  const { checked, dead, challenge, by_retailer, week, annotation } = parsed.data;
  if (dead > checked || (challenge ?? 0) + dead > checked) {
    return Response.json({ error: "dead + challenge cannot exceed checked" }, { status: 400 });
  }

  const hasCounts = checked > 0 || Object.keys(by_retailer).length > 0;
  try {
    // Counter fold and annotation stamp are separate writes by design: an
    // annotation-only post (the W37 backfill) must not bump runs/checked.
    if (hasCounts) {
      await recordLinkSmoke({ checked, dead, challenge, byRetailer: by_retailer });
    }
    if (annotation) {
      await annotateLinkSmoke(annotation, { week });
    }
    if (!hasCounts && !annotation) {
      return Response.json({ error: "empty payload" }, { status: 400 });
    }
  } catch (err) {
    console.error("metrics store write failed", err);
    return Response.json({ error: "metrics store unavailable" }, { status: 503 });
  }
  return Response.json({ accepted: true }, { status: 202 });
}
