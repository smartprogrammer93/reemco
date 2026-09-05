/**
 * REEA-37 — anonymous funnel event ingestion endpoint (AC-1, AC-6).
 *
 * POST /api/events  { events: [...] } or a single event object.
 * Hardening (AC-6): JSON-only, 16 KB payload cap, schema validation with
 * per-field bounds, 120 req/min sliding-window rate limit per caller.
 * The rate-limit key (client IP) is used in memory only — never persisted.
 * No cookies are set; the 202 response contains no client data (AC-3).
 */
import type { NextRequest } from "next/server";
import { validateEventBatch, MAX_EVENTS_PER_REQUEST } from "@/lib/events";
import { appendEvents } from "@/lib/event-store";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const gate = checkRateLimit(clientKey(req), Date.now());
  if (!gate.allowed) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
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
  if (body == null || typeof body !== "object") {
    return Response.json({ error: "expected an event object or { events: [...] }" }, { status: 400 });
  }

  const { accepted, rejected } = validateEventBatch(body);
  try {
    if (accepted.length > 0) appendEvents(accepted);
  } catch (err) {
    // e.g. read-only filesystem: fail loudly rather than silently dropping events.
    console.error("event store write failed", err);
    return Response.json({ error: "event store unavailable" }, { status: 503 });
  }
  return Response.json(
    { accepted: accepted.length, rejected, max_batch: MAX_EVENTS_PER_REQUEST },
    { status: 202 },
  );
}
