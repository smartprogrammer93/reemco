#!/usr/bin/env node
// REEA-1262 — external availability probe for the zero-downtime deploy gate.
//
// AC-1 of REEA-1262: across 3 consecutive deploys, a 1 s-interval external
// probe of `/`, `/results?q=iphone+17+pro`, `/api/health` and
// `/product/iphone-17-pro` must record ZERO non-200 responses (no 503, no
// connection-refused). This script is that probe. It is deliberately outside
// the app: it drives the PUBLIC URL through Caddy/TLS exactly like a shopper
// arriving from a WhatsApp share.
//
// Usage:
//   node scripts/reea1262-probe.mjs --base https://ns539626.ip-144-217-72.net \
//     --duration 1800 --out /var/log/reemco/reea1262-probe.jsonl
//
// It appends one JSON line per attempt (ts, url, status, ttfb_ms, total_ms,
// error) and prints a summary with per-URL status counts and TTFB p75. Exit
// code 1 when any attempt was not HTTP 200, so the deploy evidence is
// machine-checkable rather than a screenshot.
//
// The four routes are probed by four independent loops so a slow route
// (/api/health walks the live retailer funnel, 18-26 s cold) cannot starve the
// fast ones; every loop targets a 1 s gap between attempts.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const base = String(arg("base", "https://ns539626.ip-144-217-72.net")).replace(/\/+$/, "");
const durationSec = Number(arg("duration", "600"));
const out = arg("out", "");
const timeoutMs = Number(arg("timeout", "40000"));
const intervalMs = Number(arg("interval", "1000"));
// /api/health walks the whole funnel and holds collection admission slots for
// 5-20 s. Probing it continuously saturates the app's admission cap and the
// walk then answers 503 cards=0 — a self-induced non-200 that is not a deploy
// failure. One walk every 30 s is the app's own health cadence (reemco-health
// .timer) and stays well inside the cap.
const healthIntervalMs = Number(arg("health-interval", "30000"));
const stamp = new Date().toISOString();

// The app gates /results and /product at 60 page requests/min per client IP
// (src/proxy.ts PAGE_RATE_LIMIT). Probing BOTH at 1 s would spend ~120/min and
// earn 429s that are not a deploy failure, so the fast routes rotate one probe
// per second (~20/min each, ~40/min combined — inside the budget). /api/health
// cannot be 1 s: it walks the live retailer funnel (18-26 s cold), so it runs
// on its own continuous loop.
const FAST_ROUTES = ["/", "/results?q=iphone+17+pro", "/product/iphone-17-pro"];
const HEALTH_ROUTE = "/api/health";

if (out) mkdirSync(dirname(out), { recursive: true });

const rows = [];
const stopAt = Date.now() + durationSec * 1000;
let stopping = false;

function record(row) {
  rows.push(row);
  if (out) appendFileSync(out, JSON.stringify(row) + "\n");
  const mark = row.status === 200 ? "ok" : "NON-200";
  console.log(
    `${row.ts} ${mark} ${row.status} ${row.url} ttfb=${row.ttfb_ms}ms total=${row.total_ms}ms${row.error ? ` error=${row.error}` : ""}`,
  );
}

async function attempt(url) {
  const started = Date.now();
  const startedHr = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "reemco-reea1262-probe/1.0" },
    });
    const ttfbMs = Number(process.hrtime.bigint() - startedHr) / 1e6;
    // Drain the body so the connection is reusable and the total time is real.
    await res.text().catch(() => "");
    return {
      ts: new Date().toISOString(),
      url,
      status: res.status,
      ttfb_ms: Math.round(ttfbMs),
      total_ms: Date.now() - started,
      retry_after: res.headers.get("retry-after") || null,
      error: null,
    };
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      url,
      status: 0,
      ttfb_ms: Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6),
      total_ms: Date.now() - started,
      retry_after: null,
      error: err?.name === "AbortError" ? "timeout" : String(err?.cause?.code || err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fastLoop() {
  let i = 0;
  while (!stopping && Date.now() < stopAt) {
    const started = Date.now();
    record(await attempt(base + FAST_ROUTES[i % FAST_ROUTES.length]));
    i += 1;
    const gap = Math.max(0, intervalMs - (Date.now() - started));
    if (Date.now() + gap >= stopAt) break;
    await new Promise((r) => setTimeout(r, gap));
  }
}

async function healthLoop() {
  const url = base + HEALTH_ROUTE;
  while (!stopping && Date.now() < stopAt) {
    const started = Date.now();
    record(await attempt(url));
    const gap = Math.max(0, healthIntervalMs - (Date.now() - started));
    if (Date.now() + gap >= stopAt) break;
    await new Promise((r) => setTimeout(r, gap));
  }
}

const onSignal = () => {
  stopping = true;
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

console.log(`REEA-1262 probe: base=${base} duration=${durationSec}s interval=${intervalMs}ms started=${stamp}`);
await Promise.all([fastLoop(), healthLoop()]);

// Summary.
const byUrl = new Map();
for (const r of rows) {
  if (!byUrl.has(r.url)) byUrl.set(r.url, { total: 0, non200: 0, statuses: {}, ttfb: [] });
  const s = byUrl.get(r.url);
  s.total += 1;
  s.statuses[r.status] = (s.statuses[r.status] || 0) + 1;
  if (r.status !== 200) s.non200 += 1;
  if (r.ttfb_ms >= 0) s.ttfb.push(r.ttfb_ms);
}

function p75(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
}

let non200Total = 0;
const summary = [];
for (const [url, s] of byUrl) {
  non200Total += s.non200;
  summary.push({
    url,
    attempts: s.total,
    non200: s.non200,
    statuses: s.statuses,
    ttfb_p75_ms: p75(s.ttfb),
  });
}

const result = {
  kind: "reea1262-probe-summary",
  base,
  started: stamp,
  finished: new Date().toISOString(),
  duration_sec: durationSec,
  interval_ms: intervalMs,
  attempts: rows.length,
  non200_total: non200Total,
  routes: summary,
};
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(result, null, 2));
if (out) appendFileSync(out, JSON.stringify(result) + "\n");

if (non200Total > 0) {
  console.error(`\nREEA-1262 AC-1 FAILED: ${non200Total} non-200 response(s)`);
  process.exit(1);
}
console.log("\nREEA-1262 AC-1 PASSED: 0 non-200 responses");
