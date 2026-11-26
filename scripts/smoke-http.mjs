/**
 * REEA-1184 — throttle-aware HTTP for the deploy gate.
 *
 * The deployed app gates the pages that run the live retailer fan-out
 * (`/results`, `/search`, `/product`) with a per-IP budget: `PAGE_RATE_LIMIT`
 * in src/proxy.ts is 60 requests/minute and a burst gets `429` plus
 * `Retry-After` instead of a fresh fan-out (REEA-1133). That is the limiter
 * doing its job — a shopper paging results never sees it.
 *
 * The funnel smoke is a machine client, so it does see it: it walks 19 timing
 * queries, then the funnel pages, and the headless browser's link prefetches
 * count against the same per-IP bucket. Before this module the smoke treated
 * every non-200 as fatal and the deploy gate rolled a healthy build back three
 * times in a row (REEA-1184, run 45728235136, step 7 "results page returned
 * HTTP 429"). The build, stamp and headers had all passed.
 *
 * Policy, in one place so the smoke cannot drift:
 *   - retry ONLY 429 and 503. Any other status is a real fault and fails fast.
 *   - honour `Retry-After` (delta-seconds or an HTTP date), capped at
 *     `maxDelayMs`; fall back to bounded exponential backoff when the header is
 *     missing, so the wait always crosses the app's 60s window.
 *   - bounded attempts (`attempts`), then throw a tagged error
 *     (`SmokeThrottledError`, `rateLimited === true`) so the caller can tell
 *     "throttled out" from "broken" — the workflow retries the gate on the
 *     former and rolls back on the latter.
 *
 * Every attempt gets a FRESH init from `initFactory`, so a per-attempt
 * `AbortSignal.timeout(...)` is not already expired when the retry fires.
 *
 * Injectable (`fetchImpl`, `sleep`) so vitest can pin the policy with a
 * stubbed fetch and zero sleeps; see src/lib/metrics/smoke-http.test.ts.
 */

/** Statuses that mean "the edge is pacing you", never "the build is broken". */
export const THROTTLE_STATUSES = [429, 503];

/** REEA-1184 default budget: enough to cross one 60s window, never unbounded. */
export const DEFAULT_RETRY = Object.freeze({
  attempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
});

/** True when a status is the app's rate limiter (or a transient 503) talking. */
export function isThrottleStatus(status) {
  return THROTTLE_STATUSES.includes(Number(status));
}

/**
 * Parse `Retry-After` into milliseconds. Accepts delta-seconds (the shape
 * src/lib/rate-limit.ts emits) and an HTTP date. Returns null when absent or
 * unparseable so the caller falls back to backoff.
 */
export function retryAfterMs(headers, now = Date.now()) {
  const raw = headers?.get?.("retry-after");
  if (raw == null) return null;
  const value = String(raw).trim();
  if (value === "") return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * The wait before attempt N+1: the served `Retry-After` when present, else
 * bounded exponential backoff. Always capped at `maxDelayMs`.
 */
export function throttleDelayMs(headers, attempt, opts = DEFAULT_RETRY) {
  const cap = Math.max(0, opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs);
  const served = retryAfterMs(headers);
  const base = Math.max(0, opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs);
  const backoff = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(cap, served ?? backoff);
}

/** A gate failure whose cause is the edge limiter, not the deployed build. */
export class SmokeThrottledError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SmokeThrottledError";
    this.rateLimited = true;
    this.status = details.status;
    this.attempts = details.attempts;
  }
}

/**
 * Generic throttle-retry loop. `runAttempt(attempt)` performs one attempt and
 * resolves the response-like object; the loop retries while its `status` is a
 * throttle status. Resolves the first non-throttled response (including real
 * 4xx/5xx, which the caller grades itself) or throws `SmokeThrottledError`.
 */
export async function withThrottleRetry(runAttempt, opts = {}) {
  const policy = { ...DEFAULT_RETRY, ...opts };
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const attempts = Math.max(1, Math.floor(policy.attempts));

  let lastStatus;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await runAttempt(attempt);
    if (!isThrottleStatus(res.status)) return res;
    lastStatus = res.status;
    if (attempt === attempts) break;
    const wait = throttleDelayMs(res.headers, attempt, policy);
    log(`throttled HTTP ${res.status} — waiting ${wait}ms before attempt ${attempt + 1}/${attempts}`);
    await sleep(wait);
  }
  throw new SmokeThrottledError(
    `throttled out after ${attempts} attempt(s) — last HTTP ${lastStatus}`,
    { status: lastStatus, attempts },
  );
}

/**
 * Fetch with the gate's throttle policy. `initOrFactory` may be a RequestInit
 * or a function returning one per attempt (use the function form whenever the
 * init carries `AbortSignal.timeout(...)`).
 */
export async function fetchWithThrottleRetry(url, initOrFactory = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const makeInit = typeof initOrFactory === "function" ? initOrFactory : () => initOrFactory;
  return withThrottleRetry(async () => fetchImpl(url, makeInit()), opts);
}

/**
 * Browser-navigation twin: a headless `page.goto` that gets a 429 document has
 * rendered nothing, so retrying the same navigation after the served cooldown
 * is the honest fix (a reload is what a shopper would do).
 */
export async function gotoWithThrottleRetry(page, url, gotoOpts = {}, opts = {}) {
  const outcome = await withThrottleRetry(async () => {
    const res = await page.goto(url, gotoOpts);
    return {
      status: res ? res.status() : 0,
      headers: res ? res.headers() : new Headers(),
      res,
    };
  }, opts);
  return outcome.res;
}
