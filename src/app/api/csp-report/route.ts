/**
 * REEA-74 — CSP violation report sink (REEA-70 Stage 1).
 *
 * POST /api/csp-report — receives browser CSP violation reports while the
 * Stage-1 enforcing policy settles. Accepts both the legacy
 * { "csp-report": {...} } body and the newer flat Reporting API shape.
 *
 * Hardening mirrors /api/events (REEA-37 AC-6): CSP-report content types
 * only (`application/csp-report`, `application/reports+json`), 16 KB body
 * cap, schema validation, rate limit per caller (REEA-826: per serverless
 * instance unless the REEA-827 shared-KV counter is bound), and a
 * bounded in-memory ring buffer (newest 200) plus a concise console line.
 * No cookies or PII are logged; document-uri is reduced to its origin.
 */
import type { NextRequest } from "next/server";
import {
  MAX_REPORT_BODY_BYTES,
  parseCspReport,
  recordViolation,
  toViolation,
} from "@/lib/csp-report";
import { checkRateLimitShared } from "@/lib/rate-limit-kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_CONTENT_TYPES = ["application/csp-report", "application/reports+json"];

function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest): Promise<Response> {
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!REPORT_CONTENT_TYPES.includes(contentType)) {
    return Response.json(
      { error: "content-type must be application/csp-report or application/reports+json" },
      { status: 415 },
    );
  }

  const gate = await checkRateLimitShared(`csp-report:${clientKey(req)}`, Date.now());
  if (!gate.allowed) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const text = await req.text();
  if (text.length > MAX_REPORT_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text || "null");
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = parseCspReport(body);
  if (parsed === null) {
    return Response.json({ error: "unrecognized CSP report shape" }, { status: 400 });
  }

  const violation = toViolation(parsed);
  recordViolation(violation);
  // Concise, PII-free log line for server-side monitoring.
  console.log(
    `csp-violation directive=${violation.directive || "?"} status=${violation.statusCode ?? "?"} ` +
      `origin=${violation.documentOrigin ?? "?"} format=${violation.format}`,
  );

  // 204 No Content — report uploads carry no response body anyway.
  return new Response(null, { status: 204 });
}
