#!/usr/bin/env node
/**
 * REEA-1250 — deploy-gate / uptime assertion for the app's memory headroom.
 *
 * Security follow-up REEA-1245 measured the browser-clearance tier ratcheting
 * the app container toward its 6 GiB cgroup: a 9.6 h instance sat at
 * 5.077-5.411 GiB `docker stats` (VmRSS 4.73 GiB), and a 40-query burst on a
 * fresh instance settled ~0.88 GiB above its baseline and never returned. The
 * failure mode is an OOM kill and a container restart, i.e. a short outage for
 * every shopper.
 *
 * This script turns that measurement into a gate: it drives a bounded burst of
 * distinct `/results` queries (the fan-out path that grows the browser tier),
 * then reads the runtime memory picture from `/api/echo` and asserts:
 *
 *   1. the image's explicit V8 heap cap is in force (`heapCapOk`);
 *   2. cgroup ANONYMOUS memory stays below 70% of the limit — `memory.current`
 *      is also recorded, but it carries reclaimable page cache from the
 *      durable volumes and is only a warning above 85%;
 *   3. the process did not restart during the burst (`uptimeSeconds` did not
 *      go backwards), the off-box proxy for "no OOMKilled event";
 *   4. with `--settle-ms`, the post-burst anonymous figure returns within 20%
 *      of the pre-burst level — the acceptance criterion from the ticket.
 *      Run this on an instance at least 2 h old; a fresh deploy's baseline is
 *      artificially low and the ratio is not meaningful yet.
 *
 * Exit 0 = pass, 1 = a real regression (the deploy workflow rolls back on it).
 * Throttle-aware: the app's per-IP page gate answers 429 + Retry-After, so the
 * burst retries through scripts/smoke-http.mjs instead of reading pacing as a
 * broken build.
 *
 * Usage:
 *   node scripts/memory-gate.mjs --base https://host [--queries 40]
 *     [--concurrency 2] [--settle-ms 300000]
 * or set SMOKE_BASE_URL / MEMORY_GATE_BASE.
 */

import { fetchWithThrottleRetry } from "./smoke-http.mjs";

const args = process.argv.slice(2);
function argValue(name, fallback = "") {
  const at = args.indexOf(name);
  if (at < 0 || at + 1 >= args.length) return fallback;
  return args[at + 1];
}
function argNumber(name, fallback) {
  const n = Number(argValue(name, ""));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const BASE = (
  argValue("--base") ||
  process.env.MEMORY_GATE_BASE ||
  process.env.SMOKE_BASE_URL ||
  process.env.BASE_URL ||
  ""
)
  .trim()
  .replace(/\/+$/, "");
const QUERIES = Math.max(1, Math.min(200, argNumber("--queries", 40)));
const CONCURRENCY = Math.max(1, Math.min(8, argNumber("--concurrency", 2)));
const SETTLE_MS = argNumber("--settle-ms", 0);
/** The ticket's ceiling: 70% of the 6 GiB cgroup. */
const MAX_ANON_PERCENT = 70;
/**
 * A transient query miss is not a memory regression. The gate asserts memory;
 * allow up to 10% of the burst to time out / answer non-200 so a busy retailer
 * hop cannot roll back a healthy build, while a wholly dead app still fails.
 */
const MAX_BURST_FAILURES = Math.max(1, Math.floor(QUERIES * 0.1));
/** memory.current warning line; page cache is reclaimable, so not fatal. */
const WARN_USED_PERCENT = 85;
/** Post-burst return-to-baseline tolerance from the acceptance criteria. */
const RETURN_TOLERANCE = 0.2;

if (!BASE) {
  console.error("MEMORY GATE FAILED — no base URL (pass --base or set SMOKE_BASE_URL)");
  process.exit(1);
}

/**
 * Distinct, realistic shopper queries. Distinctness is the point: a repeat
 * query replays the shared snapshot/cache and never exercises the fan-out.
 */
const QUERIES_POOL = [
  "iPhone 17 Pro",
  "iPhone 16",
  "Samsung Galaxy S25",
  "Samsung Galaxy A56",
  "laptop",
  "gaming laptop",
  "MacBook Air M4",
  "iPad Air",
  "air fryer",
  "coffee machine",
  "Nespresso capsules",
  "baby diapers",
  "Pampers size 4",
  "olive oil",
  "basmati rice",
  "washing machine",
  "refrigerator",
  "air conditioner",
  "split AC 1.5 ton",
  "television 65 inch",
  "OLED TV",
  "PlayStation 5",
  "Nintendo Switch",
  "Xbox Series X",
  "wireless earbuds",
  "AirPods Pro",
  "smart watch",
  "Apple Watch Series 10",
  "power bank",
  "vacuum cleaner",
  "robot vacuum",
  "blender",
  "microwave oven",
  "electric kettle",
  "toaster",
  "hair dryer",
  "perfume",
  "Dior Sauvage",
  "skin care serum",
  "running shoes",
];

function queryAt(index) {
  const base = QUERIES_POOL[index % QUERIES_POOL.length];
  // Guarantee distinct URLs even past the pool length.
  return index < QUERIES_POOL.length ? base : `${base} ${index + 1}`;
}

async function readEcho(label) {
  const res = await fetchWithThrottleRetry(
    `${BASE}/api/echo`,
    () => ({
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    }),
    { log: console.log },
  );
  if (!res.ok) throw new Error(`${label} /api/echo returned HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== "object") throw new Error(`${label} /api/echo answered no JSON object`);
  return body;
}

function memoryOf(echo) {
  const memory = echo?.memory;
  if (!memory || typeof memory !== "object") throw new Error("/api/echo carried no memory object");
  return memory;
}

function mb(bytes) {
  return bytes == null ? "?" : `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
}

function pct(value) {
  return value == null ? "?" : `${Number(value).toFixed(2)}%`;
}

async function burst() {
  let next = 0;
  let done = 0;
  let failed = 0;
  const started = Date.now();
  async function worker() {
    while (next < QUERIES) {
      const index = next++;
      const url = `${BASE}/results?q=${encodeURIComponent(queryAt(index))}`;
      try {
        const res = await fetchWithThrottleRetry(
          url,
          () => ({
            headers: {
              accept: "text/html",
              // Force the cold/staged render the gate is about; a warm serve
              // replays a snapshot and skips the fan-out.
              cookie: "rc_refresh=1",
              "cache-control": "max-age=0",
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(60_000),
          }),
          { log: console.log },
        );
        if (!res.ok) throw new Error(`/results?q=${queryAt(index)} returned HTTP ${res.status}`);
        // Drain the body: the staged fan-out runs behind the streamed render,
        // so cancelling early can leave the burst measuring a half-walk.
        await res.text();
        done += 1;
      } catch (err) {
        failed += 1;
        console.error(`  burst query ${index + 1}/${QUERIES} failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { done, failed, ms: Date.now() - started };
}

function checkBaseline(echo) {
  const memory = memoryOf(echo);
  if (memory.heapCapOk !== true) {
    throw new Error(
      `the image's V8 heap cap is NOT in force (heapLimitBytes=${mb(memory.heapLimitBytes)}, cap=${mb(memory.heapCapBytes)}) — start the app with --max-old-space-size=2048`,
    );
  }
  if (typeof echo?.browserRecycle?.recycles !== "number") {
    throw new Error("/api/echo carried no browserRecycle counters — the deployed build predates REEA-1250");
  }
  return memory;
}

function checkPostBurst(before, after, burstResult) {
  const memory = memoryOf(after);
  const problems = [];
  if (burstResult.failed > MAX_BURST_FAILURES) {
    problems.push(`${burstResult.failed}/${QUERIES} burst queries failed (tolerance ${MAX_BURST_FAILURES})`);
  }
  const upBefore = Number(before.uptimeSeconds ?? 0);
  const upAfter = Number(memory.uptimeSeconds ?? 0);
  if (!(upAfter >= upBefore)) {
    problems.push(
      `the process restarted during the burst (uptime ${upBefore}s -> ${upAfter}s) — the OOM signature`,
    );
  }
  if (memory.heapCapOk !== true) {
    problems.push(`heap cap missing (heapLimitBytes=${mb(memory.heapLimitBytes)})`);
  }
  if (memory.anonPercent != null && Number(memory.anonPercent) >= MAX_ANON_PERCENT) {
    problems.push(`cgroup anonymous memory ${pct(memory.anonPercent)} >= ${MAX_ANON_PERCENT}%`);
  }
  const warnings = [];
  if (burstResult.failed > 0 && burstResult.failed <= MAX_BURST_FAILURES) {
    warnings.push(`${burstResult.failed}/${QUERIES} burst queries were transient misses — memory sample still valid`);
  }
  if (memory.usedPercent != null && Number(memory.usedPercent) >= WARN_USED_PERCENT) {
    warnings.push(
      `cgroup memory.current ${pct(memory.usedPercent)} (page cache included, reclaimable) — watch, not fatal`,
    );
  }
  return { memory, problems, warnings };
}

function checkSettled(before, settled) {
  const memory = memoryOf(settled);
  const problems = [];
  if (memory.anonPercent != null && Number(memory.anonPercent) >= MAX_ANON_PERCENT) {
    problems.push(`settled cgroup anonymous memory ${pct(memory.anonPercent)} >= ${MAX_ANON_PERCENT}%`);
  }
  const baselineAnon = before.cgroup?.anonBytes ?? before.anonBytes ?? null;
  const settledAnon = memory.cgroup?.anonBytes ?? memory.anonBytes ?? null;
  if (baselineAnon != null && settledAnon != null && baselineAnon > 0) {
    const ratio = settledAnon / baselineAnon;
    if (ratio > 1 + RETURN_TOLERANCE) {
      problems.push(
        `settled anonymous memory ${mb(settledAnon)} is ${((ratio - 1) * 100).toFixed(1)}% above the ${mb(
          baselineAnon,
        )} baseline (tolerance 20%)`,
      );
    }
    return { problems, ratio, baselineAnon, settledAnon };
  }
  return { problems, ratio: null, baselineAnon, settledAnon };
}

function summarize(label, memory, browserRecycle) {
  const recycles = browserRecycle?.recycles ?? "?";
  const navigations = browserRecycle?.navigationsTotal ?? "?";
  const lastReason = browserRecycle?.lastRecycleReason || "none";
  console.log(
    `${label}: anon=${mb(memory.cgroup?.anonBytes ?? memory.anonBytes)} (${pct(memory.anonPercent)}) used=${mb(
      memory.cgroup?.usedBytes ?? memory.usedBytes,
    )} (${pct(memory.usedPercent)}) rss=${mb(memory.rssBytes)} heap=${mb(memory.heapUsedBytes)}/${mb(
      memory.heapLimitBytes,
    )} capOk=${memory.heapCapOk} uptime=${memory.uptimeSeconds}s browserRecycles=${recycles} navs=${navigations} last=${lastReason}`,
  );
}

async function main() {
  console.log(`MEMORY GATE — ${BASE} — ${QUERIES} distinct /results queries, concurrency ${CONCURRENCY}`);
  const baselineEcho = await readEcho("baseline");
  const baseline = checkBaseline(baselineEcho);
  summarize("baseline", baseline, baselineEcho.browserRecycle);

  const burstResult = await burst();
  console.log(
    `burst: ${burstResult.done}/${QUERIES} answered, ${burstResult.failed} failed, ${(burstResult.ms / 1000).toFixed(1)}s`,
  );

  // Give the app one settle beat so the last navigation's recycle can run
  // before the post-burst sample; a recycle requested by the final page drains
  // as that page closes.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const afterEcho = await readEcho("post-burst");
  const after = memoryOf(afterEcho);
  summarize("post-burst", after, afterEcho.browserRecycle);
  const post = checkPostBurst(baseline, afterEcho, burstResult);

  let settled = null;
  if (SETTLE_MS > 0) {
    console.log(`settling ${(SETTLE_MS / 1000).toFixed(0)}s before the return-to-baseline sample…`);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const settledEcho = await readEcho("settled");
    const settledMemory = memoryOf(settledEcho);
    summarize("settled", settledMemory, settledEcho.browserRecycle);
    settled = checkSettled(baseline, settledEcho);
  }

  const problems = [...post.problems, ...(settled?.problems ?? [])];
  for (const warning of post.warnings) console.warn(`  WARNING: ${warning}`);

  const line = {
    base: BASE,
    queries: QUERIES,
    answered: burstResult.done,
    failed: burstResult.failed,
    baselineAnonPercent: baseline.anonPercent ?? null,
    postAnonPercent: post.memory.anonPercent ?? null,
    postUsedPercent: post.memory.usedPercent ?? null,
    heapCapOk: post.memory.heapCapOk === true,
    uptimeBefore: baseline.uptimeSeconds ?? null,
    uptimeAfter: post.memory.uptimeSeconds ?? null,
    browserRecycles: afterEcho.browserRecycle?.recycles ?? null,
    settledAnonPercent: settled ? settled.ratio : null,
    problems,
  };
  console.log(`MEMORY_GATE: ${JSON.stringify(line)}`);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  FAIL: ${problem}`);
    console.error(`MEMORY GATE FAILED — ${BASE}`);
    process.exit(1);
  }
  console.log(`MEMORY GATE PASSED — ${BASE}`);
}

main().catch((err) => {
  console.error(`MEMORY GATE FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
