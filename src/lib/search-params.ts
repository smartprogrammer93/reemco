/**
 * REEA-13 / AC-U4 (PM, REEA-20 Spec 3) — search-parameter hardening.
 *
 * Client-side defense for /results?q=... : malformed or oversized params
 * degrade to the zero-result state instead of erroring or passing attacker-
 * controlled blobs downstream. Complements ingestion hardening (F3) by
 * bounding the browser->app input flow (STRIDE flow C).
 *
 * Security lenses: Input validation (allowlist/bounds), Fail Securely,
 * Rate limiting and abuse (caps blunt trivial DoS via huge params).
 */

const MAX_QUERY_LENGTH = 200;
const MAX_PAGE = 10_000;

/** Strip control chars, collapse whitespace, cap length; null on no usable query. */
export function sanitizeSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  // Truncate safely (codepoint-safe: Array.from splits by code points).
  return Array.from(cleaned).slice(0, MAX_QUERY_LENGTH).join("");
}

/** Bounded page/offset: non-integer, negative, or oversized values degrade to 1. */
export function sanitizePage(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) return 1;
  return n;
}
