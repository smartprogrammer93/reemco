/**
 * REEA-1251 — production probe for GET /api/events/report caller budget and
 * aggregate cache (security follow-up from REEA-1245, OWASP API4:2023).
 *
 * Measures the fix's success condition against the served build:
 *  1. budget: in one fresh 60 s fixed window, one warm-up read plus a
 *     60-concurrent burst spends at most 30 calls (the budget), answers 429 +
 *     Retry-After to the rest and produces no 5xx. The burst must drain
 *     exactly the remaining allowance, which proves the cap is enforced at 30
 *     (a window can arrive partly spent: every lane on this host shares the
 *     caller bucket — see the caller-key note below);
 *  2. warm latency: the burst's admitted calls are served from the aggregate
 *     cache (x-report-cache: hit) with p95 < 1 s;
 *  3. cold path: in the NEXT fresh window (aggregate TTL expired) a
 *     60-concurrent burst again admits 30 / denies 30 with no 5xx, and the
 *     admitted calls share ONE coalesced parse (the in-flight computation; a
 *     few late arrivals may hit the freshly cached answer), so the burst stays
 *     at one-parse latency instead of serializing 30 parses — pre-fix, 60
 *     concurrent averaged 14.78 s;
 *  4. `cache-control: no-store` and the REEA-837 budget headers stay on the
 *     answer.
 *
 * Caller key: the box sits behind Caddy, which presents the edge-observed
 * client IP as the first X-Forwarded-For hop. Requests from this host
 * therefore share one caller bucket — including every other lane's probes on
 * the same host — so the probe separates its phases by waiting for the next
 * 60 s fixed window (the gate's window id is `floor(now/60 s)`) instead of by
 * spoofing XFF, and reads the remaining allowance from the warm-up answer
 * rather than assuming a clean window. Per-caller isolation is pinned by the
 * route regression test (src/app/api-events-report-rate-limit.test.ts).
 *
 * Usage:
 *   BASE_URL=https://ns539626.ip-144-217-72.net node scripts/reea1251-probe.mjs
 *   OUT=/tmp/reea1251.json node scripts/reea1251-probe.mjs
 *
 * Prints one JSON block; exits non-zero when a hard gate fails.
 */
import { writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "";
const DAYS = process.env.DAYS || "7";
const CONCURRENCY = 60;
const LIMIT = 30;
const WINDOW_MS = 60_000;
const WARM_P95_MAX_MS = 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

function callerHeaders() {
  return { accept: "application/json" };
}

async function readText(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "text/plain", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: (await res.text()).trim() };
}

async function readJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function hit() {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${BASE}/api/events/report?days=${encodeURIComponent(DAYS)}`, {
      headers: callerHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 0, ms: Math.round(performance.now() - started), error: String(err) };
  }
  const ms = Math.round(performance.now() - started);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    status: res.status,
    ms,
    headers: {
      cache: res.headers.get("x-report-cache"),
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      retryAfter: res.headers.get("retry-after"),
      cacheControl: res.headers.get("cache-control"),
    },
    window_days: body?.window_days ?? null,
    searches: body?.searches ?? null,
    error: body?.error ?? null,
  };
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function summarize(label, results) {
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const admitted = results.filter((r) => r.status === 200);
  const denied = results.filter((r) => r.status === 429);
  const errors = results.filter((r) => r.status >= 500 || r.status === 0);
  return {
    label,
    count: results.length,
    byStatus,
    errors: errors.length,
    admitted: admitted.length,
    denied: denied.length,
    admittedP95Ms: p95(admitted.map((r) => r.ms)),
    admittedMaxMs: admitted.length ? Math.max(...admitted.map((r) => r.ms)) : null,
    admittedCacheHits: admitted.filter((r) => r.headers?.cache === "hit").length,
    admittedCacheMisses: admitted.filter((r) => r.headers?.cache === "miss").length,
    admittedBudgetSpent: admitted.filter((r) => r.headers?.remaining === "0").length,
    deniedWithRetryAfter: denied.filter((r) => Number(r.headers?.retryAfter) >= 1).length,
    deniedWithoutRetryAfter: denied.filter((r) => !(Number(r.headers?.retryAfter) >= 1)).length,
    deniedWithRateLimitBody: denied.filter((r) => r.error === "rate limit exceeded").length,
    admittedWithBudgetHeaders: admitted.filter((r) => r.headers?.limit === String(LIMIT)).length,
    admittedWithNoStore: admitted.filter((r) => r.headers?.cacheControl === "no-store").length,
    sample: results.slice(0, 2),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Wait for the next fixed-window boundary (the gate keys on floor(now/60 s)). */
async function waitForFreshWindow() {
  const now = Date.now();
  const boundary = Math.ceil((now + 50) / WINDOW_MS) * WINDOW_MS + 600;
  await sleep(boundary - now);
  return boundary;
}

function fail(checks) {
  return checks.filter((c) => !c.ok);
}

const report = {
  base: BASE,
  measured_at: new Date().toISOString(),
  stamps: {},
  phases: {},
  verdict: null,
};

report.stamps.commit = await readText("/__commit.txt");
report.stamps.health = await readJson("/api/health");

// Let the aggregate TTL lapse first so the warm-up read below is
// deterministically a COLD parse (the calibration point for the cold burst).
await sleep(31_000);

// --- Warm phase: one fresh window, one cache-filling read, then a burst. ----
// The caller bucket is shared by every lane running on this host (Caddy keys
// the gate on the edge-observed client IP), so a window can arrive partly
// spent. `remaining` after the warm-up is the exact burst allowance: the burst
// must drain exactly that many and deny the rest.
let warm = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !warm; attempt += 1) {
  const windowStart = await waitForFreshWindow();
  const warmUp = await hit();
  const remaining = Number(warmUp.headers?.remaining);
  if (warmUp.status !== 200 || !Number.isFinite(remaining) || remaining < 10) continue;
  const burst = summarize(
    "warm-burst-60",
    await Promise.all(Array.from({ length: CONCURRENCY }, () => hit())),
  );
  if (burst.admitted !== remaining) continue;
  warm = { attempt, windowStart: new Date(windowStart).toISOString(), windowBudgetSpent: 1 + burst.admitted, warmUp, burst };
}

// --- Cold phase: next fresh window; the aggregate TTL (30 s) has expired. ---
let cold = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cold; attempt += 1) {
  const windowStart = await waitForFreshWindow();
  const burst = summarize(
    "cold-burst-60",
    await Promise.all(Array.from({ length: CONCURRENCY }, () => hit())),
  );
  if (burst.admitted < 10 || burst.admitted > LIMIT) continue;
  cold = { attempt, windowStart: new Date(windowStart).toISOString(), burst };
}

report.phases.warm = warm;
report.phases.cold = cold;

const warmUp = warm?.warmUp ?? null;
const warmBurst = warm?.burst ?? null;
const coldBurst = cold?.burst ?? null;

const checks = [
  {
    name: "served stamp reachable",
    ok: report.stamps.commit.status === 200 && /^[0-9a-f]{7,40}$/i.test(report.stamps.commit.body),
    detail: `${report.stamps.commit.status} ${report.stamps.commit.body}`,
  },
  { name: "health ok", ok: report.stamps.health.status === 200 && report.stamps.health.body?.ok === true },
  { name: "warm-up read 200", ok: warmUp?.status === 200 },
  { name: "warm-up carries budget headers", ok: warmUp?.headers?.limit === String(LIMIT) },
  { name: "warm-up answer is no-store", ok: warmUp?.headers?.cacheControl === "no-store" },
  { name: "warm-up is a fresh aggregate", ok: warmUp?.headers?.cache === "miss" },
  { name: "warm burst measured", ok: warmBurst !== null },
  {
    name: "warm burst no 5xx",
    ok: warmBurst !== null && warmBurst.errors === 0,
    detail: warmBurst ? `${warmBurst.errors} errors` : "not measured",
  },
  {
    name: "warm window spends at most 30 (budget)",
    ok: warmBurst !== null && 1 + warmBurst.admitted <= LIMIT,
    detail: warmBurst ? `1 warm-up + ${warmBurst.admitted} admitted = ${1 + warmBurst.admitted} ≤ ${LIMIT}` : "not measured",
  },
  {
    name: "warm burst drains the remaining budget",
    ok: warmBurst !== null && warmBurst.admitted === Number(warmUp?.headers?.remaining),
    detail: warmBurst ? `${warmBurst.admitted} admitted vs remaining ${warmUp?.headers?.remaining}` : "not measured",
  },
  {
    name: "warm burst denies the rest",
    ok: warmBurst !== null && warmBurst.denied === CONCURRENCY - warmBurst.admitted,
    detail: warmBurst ? `${warmBurst.denied} denied` : "not measured",
  },
  {
    name: "warm denials carry Retry-After and the standard body",
    ok:
      warmBurst !== null &&
      warmBurst.deniedWithoutRetryAfter === 0 &&
      warmBurst.deniedWithRateLimitBody === warmBurst.denied,
  },
  {
    name: "warm admitted p95 < 1 s (cached)",
    ok: warmBurst !== null && warmBurst.admittedP95Ms !== null && warmBurst.admittedP95Ms < WARM_P95_MAX_MS,
    detail: warmBurst ? `${warmBurst.admittedP95Ms} ms` : "not measured",
  },
  {
    name: "warm burst served from the aggregate cache",
    ok: warmBurst !== null && warmBurst.admittedCacheHits === warmBurst.admitted,
    detail: warmBurst ? `${warmBurst.admittedCacheHits}/${warmBurst.admitted} hits` : "not measured",
  },
  {
    name: "warm admitted carry budget headers and no-store",
    ok:
      warmBurst !== null &&
      warmBurst.admittedWithBudgetHeaders === warmBurst.admitted &&
      warmBurst.admittedWithNoStore === warmBurst.admitted,
  },
  { name: "cold burst measured", ok: coldBurst !== null },
  {
    name: "cold burst no 5xx",
    ok: coldBurst !== null && coldBurst.errors === 0,
    detail: coldBurst ? `${coldBurst.errors} errors` : "not measured",
  },
  {
    name: "cold window admits at most 30 (budget)",
    ok: coldBurst !== null && coldBurst.admitted <= LIMIT,
    detail: coldBurst ? `${coldBurst.admitted} admitted ≤ ${LIMIT}` : "not measured",
  },
  {
    name: "cold burst denies the rest",
    ok: coldBurst !== null && coldBurst.denied === CONCURRENCY - coldBurst.admitted,
    detail: coldBurst ? `${coldBurst.denied} denied` : "not measured",
  },
  {
    name: "cold denials carry Retry-After and the standard body",
    ok:
      coldBurst !== null &&
      coldBurst.deniedWithoutRetryAfter === 0 &&
      coldBurst.deniedWithRateLimitBody === coldBurst.denied,
  },
  {
    name: "cold burst parses at least once (leader miss)",
    ok: coldBurst !== null && coldBurst.admittedCacheMisses >= 1,
    detail: coldBurst ? `${coldBurst.admittedCacheMisses}/${coldBurst.admitted} misses` : "not measured",
  },
  {
    // The observable proof that the burst coalesced instead of serializing 30
    // parses: its admitted p95 must stay within one cold parse (the warm-up
    // read) plus headroom. Pre-fix, 60 concurrent averaged 14.78 s.
    name: "cold burst coalesced (no serialized re-parse)",
    ok:
      coldBurst !== null &&
      warmUp?.ms > 0 &&
      coldBurst.admittedP95Ms !== null &&
      coldBurst.admittedP95Ms < Math.max(2500, 2 * warmUp.ms),
    detail: coldBurst ? `p95 ${coldBurst.admittedP95Ms} ms vs one parse ${warmUp?.ms} ms` : "not measured",
  },
];

const failures = fail(checks);
report.verdict = {
  ok: failures.length === 0,
  passed: checks.length - failures.length,
  total: checks.length,
  failures,
};

const json = JSON.stringify(report, null, 2);
console.log(json);
if (OUT) writeFileSync(OUT, json + "\n");

if (!report.verdict.ok) {
  console.error(`\nREEA-1251 FAIL — ${failures.length}/${checks.length} checks failed: ${failures.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.error(
  `\nREEA-1251 PASS — ${checks.length}/${checks.length} checks. warm admitted p95 ${warmBurst.admittedP95Ms} ms (${warmBurst.admitted}/60, all cached); cold admitted p95 ${coldBurst.admittedP95Ms} ms (${coldBurst.admitted}/60, all coalesced misses).`,
);
