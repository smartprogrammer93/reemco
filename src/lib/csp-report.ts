/**
 * REEA-74 — CSP violation report sink support (REEA-70 Stage 1).
 *
 * Pure validation + bounded in-memory ring buffer so the route handler in
 * src/app/api/csp-report/route.ts stays thin and the logic is unit-testable.
 *
 * Privacy: only directive/effective-directive, status code, and a truncated
 * source file are retained. document-uri is reduced to its origin, and no
 * cookies or other PII are stored or logged.
 */

export const MAX_REPORT_BODY_BYTES = 16 * 1024;
const RING_CAPACITY = 200;
const MAX_STRING = 512;

/** One sanitized, retained violation report. */
export interface CspViolation {
  ts: string;
  /** Report format: "legacy" ({ "csp-report": ... }) or "modern" (flat). */
  format: "legacy" | "modern";
  directive: string;
  statusCode: number | null;
  /** Origin only (scheme://host), never the full URL with path/query. */
  documentOrigin: string | null;
  /** Truncated blocked/source URL — may be empty. */
  sourceFile: string;
}

const ring: CspViolation[] = [];

/** Record a validated violation into the bounded ring buffer (newest last). */
export function recordViolation(
  v: CspViolation,
  store: CspViolation[] = ring,
  capacity: number = RING_CAPACITY,
): void {
  store.push(v);
  if (store.length > capacity) store.splice(0, store.length - capacity);
}

/** Most recent violations, newest first. Bounded read-only snapshot. */
export function recentViolations(limit = 50, store: CspViolation[] = ring): CspViolation[] {
  return store.slice(-Math.max(1, Math.min(limit, capacityOf(store)))).reverse();
}

function capacityOf(store: CspViolation[]): number {
  return store.length;
}

/** Test helper: clear the shared ring buffer. */
export function resetViolations(store: CspViolation[] = ring): void {
  store.length = 0;
}

function truncate(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.length > MAX_STRING ? raw.slice(0, MAX_STRING) : raw;
}

/** document-uri reduced to origin, or null if unparseable/absent. */
function toOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export interface ParsedReport {
  format: "legacy" | "modern";
  directive: string;
  statusCode: number | null;
  documentUri: unknown;
  sourceFile: string;
}

/**
 * Schema-validate a parsed report body. Accepts both the legacy
 * { "csp-report": { "violated-directive": ... } } shape and the newer
 * flat Reporting API shape ({ "type": "csp-violation", body: {...} }).
 * Returns null when the body does not match either schema.
 */
export function parseCspReport(body: unknown): ParsedReport | null {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;

  const inner =
    typeof obj["csp-report"] === "object" && obj["csp-report"] !== null
      ? (obj["csp-report"] as Record<string, unknown>)
      : typeof obj.body === "object" && obj.body !== null
        ? (obj.body as Record<string, unknown>)
        : null;
  if (inner === null) return null;

  const format: "legacy" | "modern" = obj["csp-report"] !== undefined ? "legacy" : "modern";

  // Field lookup across both spellings: legacy snake_case and the newer
  // Reporting API camelCase (effectiveDirective, blockedURL, ...).
  const field = (...names: string[]): unknown => {
    for (const n of names) {
      const v = inner[n];
      if (v !== undefined) return v;
    }
    return undefined;
  };

  // Must carry at least one recognizable CSP violation field.
  const directiveRaw = field("effective-directive", "effectiveDirective", "violated-directive", "violatedDirective", "directive");
  const directive = typeof directiveRaw === "string" ? directiveRaw : "";
  const hasViolationSignal =
    directive !== "" ||
    typeof field("blocked-uri", "blockedURL", "blockedURI") === "string" ||
    typeof field("source-file", "sourceFile") === "string" ||
    typeof field("document-uri", "documentURI", "documentURL") === "string" ||
    typeof field("original-policy", "originalPolicy") === "string" ||
    typeof field("sample") === "string";
  if (!hasViolationSignal) return null;

  const statusRaw = field("status-code", "statusCode");
  const statusCode =
    typeof statusRaw === "number" && Number.isFinite(statusRaw) ? statusRaw : null;

  return {
    format,
    directive: truncate(directive),
    statusCode,
    documentUri: field("document-uri", "documentURI", "documentURL"),
    sourceFile: truncate(
      (field("source-file", "sourceFile") ?? field("blocked-uri", "blockedURL", "blockedURI") ?? "") as string,
    ),
  };
}

/** Convert a parsed report into the retained, privacy-safe violation record. */
export function toViolation(p: ParsedReport, now: Date = new Date()): CspViolation {
  return {
    ts: now.toISOString(),
    format: p.format,
    directive: p.directive,
    statusCode: p.statusCode,
    documentOrigin: toOrigin(p.documentUri),
    sourceFile: p.sourceFile,
  };
}
