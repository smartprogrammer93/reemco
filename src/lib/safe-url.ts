/**
 * F1 remediation — external URL sanitization (REEA-13).
 *
 * Ingestion-time, fix-the-class validator for scraped third-party URLs.
 * Allowlist: https:/http: only; rejects userinfo (user:pass@), control
 * characters, and length > 2048. Defense-in-depth render-time helper
 * `safeHref` shares the same rules so every link render site is covered.
 *
 * Security lenses: Input validation (allowlist), Secure Defaults,
 * Fail Securely (returns null on any doubt, never falls through).
 */

const MAX_URL_LENGTH = 2048;
const ALLOWED_SCHEMES = new Set(["https:", "http:"]);
// C0 controls, DEL, and line/tab characters that can confuse href parsing.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class InvalidExternalUrlError extends Error {
  public readonly reason: string;
  public readonly value: string;
  constructor(reason: string, value: string) {
    super(`Invalid external URL (${reason})`);
    this.name = "InvalidExternalUrlError";
    this.reason = reason;
    this.value = value;
  }
}

/**
 * Validate a scraped URL for storage. Throws on violation so ingestion
 * callers cannot silently persist a malicious value.
 */
export function assertSafeExternalUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InvalidExternalUrlError("not a non-empty string", String(raw));
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new InvalidExternalUrlError("exceeds 2048 chars", raw.slice(0, 64));
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new InvalidExternalUrlError("contains control characters", raw.slice(0, 64));
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidExternalUrlError("unparseable URL", raw.slice(0, 64));
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new InvalidExternalUrlError(`scheme not allowed: ${url.protocol}`, raw.slice(0, 64));
  }
  // Reject user:pass@ (and bare user@) — phishing/host-confusion vector and
  // never needed for a product/offer link.
  if (url.username || url.password) {
    throw new InvalidExternalUrlError("userinfo in URL", raw.slice(0, 64));
  }
  if (!url.hostname) {
    throw new InvalidExternalUrlError("missing hostname", raw.slice(0, 64));
  }
  return url;
}

/**
 * Ingestion-time normalize: returns the canonicalized URL string, or null if
 * invalid. Use where scraper output enters the data layer; persist null
 * rather than a rejected value.
 */
export function sanitizeExternalUrl(raw: unknown): string | null {
  try {
    return assertSafeExternalUrl(raw).toString();
  } catch {
    return null;
  }
}

/**
 * Render-time defense-in-depth: use for every `<a href>` built from scraped
 * data. Returns a safe string or null (render the link only when non-null).
 * Shares the same allowlist as ingestion so a bypass of one layer fails
 * closed at the other.
 */
export function safeHref(raw: unknown): string | null {
  return sanitizeExternalUrl(raw);
}
