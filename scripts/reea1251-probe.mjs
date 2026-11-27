/**
 * REEA-1251 — production probe for GET /api/events/report caller budget and
 * aggregate cache (security follow-up from REEA-1245, OWASP API4:2023).
 *
 * Measures the fix's success condition against the served build:
 *  1. solo read: status, latency, and the REEA-837 budget headers;
 *  2. warm 60-concurrent burst (one caller): at most 30 admitted, the rest 429
 *     with Retry-After, NO 5xx, admitted p95 < 1 s with the aggregate cached,
 *     and one blob parse for the whole burst (x-report-cache hit on admitted);
 *  3. cold 60-concurrent burst (cache TTL expired): still no 5xx and at most 30
 *     admitted — the single-flight cache parses the blob once;
 *  4. per-caller isolation: a drained caller is 429 while a fresh caller is 200.
 *
 * Callers are separated by the first X-Forwarded-For hop, the key the gated
 * routes already use (TEST-NET-2 addresses, so nothing collides with a real
 * shopper). Caddy appends the peer address to a client-supplied XFF; the app
 * reads the first hop, so the probe can hold distinct budgets.
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
const WARM_P95_MAX_MS = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

const CALLER_SOLO = "198.51.100.11";
const CALLER_WARM = "198.51.100.12";
const CALLER_COLD = "198.51.100.13";
const CALLER_FRESH = "198.51.100.14";

function callerHeaders(ip) {
  return { accept: "application/json", "x-forwarded-for": ip };
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

async function hit(ip) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${BASE}/api/events/report?days=${encodeURIComponent(DAYS)}`, {
      headers: callerHeaders(ip),
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
    deniedWithRetryAfter: denied.filter((r) => Number(r.headers?.retryAfter) >= 1).length,
    deniedWithoutRetryAfter: denied.filter((r) => !(Number(r.headers?.retryAfter) >= 1)).length,
    admittedWithBudgetHeaders: admitted.filter((r) => r.headers?.limit === String(LIMIT)).length,
    admittedWithNoStore: admitted.filter((r) => r.headers?.cacheControl === "no-store").length,
    sample: results.slice(0, 3),
  };
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

// 1. Solo read — cold or warm depending on the running process.
report.phases.solo = await hit(CALLER_SOLO);
await new Promise((r) => setTimeout(r, 1200));

// 2. Warm burst: CALLER_SOLO's read above already populated the aggregate
// cache, and CALLER_WARM has a fresh budget.
report.phases.warmBurst = summarize(
  "warm-burst-60",
  await Promise.all(Array.from({ length: CONCURRENCY }, () => hit(CALLER_WARM))),
);

// 3. Per-caller isolation: CALLER_WARM is now drained; CALLER_FRESH must pass.
report.phases.isolationDrained = await hit(CALLER_WARM);
report.phases.isolationFresh = await hit(CALLER_FRESH);

// 4. Cold burst: wait past the 30 s aggregate TTL so the blob must be parsed
// again, then burst from a caller with a full budget.
await new Promise((r) => setTimeout(r, 31_000));
report.phases.coldBurst = summarize(
  "cold-burst-60",
  await Promise.all(Array.from({ length: CONCURRENCY }, () => hit(CALLER_COLD))),
);

const warm = report.phases.warmBurst;
const cold = report.phases.coldBurst;
const checks = [
  {
    name: "served stamp reachable",
    ok: report.stamps.commit.status === 200 && /^[0-9a-f]{7,40}$/i.test(report.stamps.commit.body),
    detail: `${report.stamps.commit.status} ${report.stamps.commit.body}`,
  },
  { name: "health ok", ok: report.stamps.health.status === 200 && report.stamps.health.body?.ok === true },
  { name: "solo read 200", ok: report.phases.solo.status === 200 },
  { name: "solo carries budget headers", ok: report.phases.solo.headers?.limit === String(LIMIT) },
  { name: "solo answer is no-store", ok: report.phases.solo.headers?.cacheControl === "no-store" },
  { name: "warm burst no 5xx", ok: warm.errors === 0, detail: `${warm.errors} errors` },
  { name: "warm burst admits exactly the budget", ok: warm.admitted === LIMIT, detail: `${warm.admitted} admitted` },
  { name: "warm burst denies the rest", ok: warm.denied === CONCURRENCY - LIMIT, detail: `${warm.denied} denied` },
  { name: "warm denials carry Retry-After", ok: warm.deniedWithoutRetryAfter === 0 },
  { name: "warm admitted p95 < 1 s (cached)", ok: warm.admittedP95Ms !== null && warm.admittedP95Ms < WARM_P95_MAX_MS, detail: `${warm.admittedP95Ms} ms` },
  { name: "warm burst served from cache", ok: warm.admittedCacheHits === warm.admitted, detail: `${warm.admittedCacheHits}/${warm.admitted} hits` },
  { name: "warm admitted carry budget headers", ok: warm.admittedWithBudgetHeaders === warm.admitted },
  { name: "warm admitted are no-store", ok: warm.admittedWithNoStore === warm.admitted },
  { name: "cold burst no 5xx", ok: cold.errors === 0, detail: `${cold.errors} errors` },
  { name: "cold burst admits at most the budget", ok: cold.admitted <= LIMIT, detail: `${cold.admitted} admitted` },
  { name: "cold burst denies the rest", ok: cold.denied === CONCURRENCY - cold.admitted },
  { name: "cold denials carry Retry-After", ok: cold.deniedWithoutRetryAfter === 0 },
  { name: "cold burst parsed once (misses coalesced)", ok: cold.admittedCacheMisses === cold.admitted, detail: `${cold.admittedCacheMisses}/${cold.admitted} misses` },
  { name: "drained caller is 429", ok: report.phases.isolationDrained.status === 429 },
  { name: "fresh caller is 200", ok: report.phases.isolationFresh.status === 200 },
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
  `\nREEA-1251 PASS — ${checks.length}/${checks.length} checks. warm p95 ${warm.admittedP95Ms} ms, cold p95 ${cold.admittedP95Ms} ms, admitted ${warm.admitted}/${CONCURRENCY} warm, ${cold.admitted}/${CONCURRENCY} cold.`,
);
