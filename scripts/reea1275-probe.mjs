#!/usr/bin/env node
/**
 * REEA-1275 — first-card paint probe on the served head.
 *
 * Measures the shopper-visible latency the ticket names: 375x812, EN chrome,
 * Kuwait default market, 8 sequential COLD loads per query (each load carries
 * the one-shot `rc_refresh=1` signal, so the per-query memo and the shared edge
 * entry are both a guaranteed miss, i.e. a real cold fan-out), and polls every
 * 50 ms for a painted `article.result-card` with a non-zero box.
 *
 * COLD_MODE selects how "cold" the browser is:
 *  - `fresh` (default): a new browser context per load — cold HTTP cache AND a
 *    cold TCP/TLS connection (the strictest reading of "cold load");
 *  - `reuse`: one context per query with the HTTP cache disabled via CDP, so
 *    each load is a cold document fetch on an already-open connection (a
 *    shopper's repeat visit, and the shape the ticket's baseline
 *    responseStart samples 315–1488 ms imply).
 *
 * Reports p50/p75/p90 of first-card paint plus the navigation split
 * (responseStart vs domContentLoadedEventEnd) so the fix can be attributed to
 * serve time or paint, and names the served stamp read before/after the run.
 *
 * Usage: node scripts/reea1275-probe.mjs [baseUrl] [query ...]
 */
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const QUERIES = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ["keychron v3 max", "iphone 17 pro"];
const SAMPLES = Number(process.env.SAMPLES ?? 8);
/** Pause between loads; 0 = back-to-back (the ticket's raw methodology). */
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 0);
const COLD_MODE = process.env.COLD_MODE ?? "fresh";
const CHROME = process.env.CHROME_PATH ?? "/opt/ms-playwright/chromium-1194/chrome-linux/chrome";
const POLL_MS = 50;
const CARD_TIMEOUT_MS = 20_000;

async function stamp() {
  const [commit, health] = await Promise.all([
    fetch(`${BASE}/__commit.txt`).then((r) => r.text()).then((t) => t.trim()),
    fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null),
  ]);
  return { commit, health };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const INIT_SCRIPT = () => {
  // Record the first frame a card has a non-zero box (independent of the
  // 50 ms poll so the report can attribute paint vs measurement delay).
  window.__firstCardFrameAt = null;
  const check = () => {
    if (window.__firstCardFrameAt !== null) return;
    const cards = document.querySelectorAll("article.result-card");
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        window.__firstCardFrameAt = performance.now();
        return;
      }
    }
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
};

async function pollCard(page, started) {
  let firstCardMs = null;
  while (Date.now() - started < CARD_TIMEOUT_MS) {
    firstCardMs = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("article.result-card"));
      for (const card of cards) {
        const r = card.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return performance.now();
      }
      return null;
    });
    if (firstCardMs !== null) break;
    await page.waitForTimeout(POLL_MS);
  }
  return firstCardMs === null ? null : Math.round(firstCardMs);
}

async function readNav(page) {
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      responseStart: n ? Math.round(n.responseStart) : null,
      domContentLoadedEventEnd: n ? Math.round(n.domContentLoadedEventEnd) : null,
      loadEventEnd: n ? Math.round(n.loadEventEnd) : null,
      duration: n ? Math.round(n.duration) : null,
      fcp: fcp ? Math.round(fcp.startTime) : null,
      firstCardFrameAt:
        window.__firstCardFrameAt === null ? null : Math.round(window.__firstCardFrameAt),
    };
  });
  return { nav, frameAt: nav.firstCardFrameAt };
}

function urlFor(query) {
  return `${BASE}/results?q=${encodeURIComponent(query)}&_r=${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function loadFresh(browser, query) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    locale: "en-US",
    extraHTTPHeaders: { "accept-language": "en-KW,en;q=0.9" },
  });
  await context.addCookies([{ name: "rc_refresh", value: "1", url: BASE }]);
  const page = await context.newPage();
  await page.addInitScript(INIT_SCRIPT);
  const started = Date.now();
  try {
    await page.goto(urlFor(query), { waitUntil: "commit", timeout: 30_000 });
    const firstCardMs = await pollCard(page, started);
    const { nav, frameAt } = await readNav(page);
    return { firstCardMs, frameAt, nav };
  } catch (err) {
    console.error(`  load failed: ${err.message}`);
    return { firstCardMs: null, frameAt: null, nav: null };
  } finally {
    await context.close();
  }
}

async function loadReuse(page, query) {
  const started = Date.now();
  try {
    await page.goto(urlFor(query), { waitUntil: "commit", timeout: 30_000 });
    const firstCardMs = await pollCard(page, started);
    const { nav, frameAt } = await readNav(page);
    return { firstCardMs, frameAt, nav };
  } catch (err) {
    console.error(`  load failed: ${err.message}`);
    return { firstCardMs: null, frameAt: null, nav: null };
  }
}

// Only the commit stamp is read BEFORE the samples: /api/health runs the
// health pass (a full results probe), and calling it first would put that
// run's tail on the box during the first samples. The full stamp attestation
// is read AFTER the sample set.
const before = {
  commit: await fetch(`${BASE}/__commit.txt`).then((r) => r.text()).then((t) => t.trim()),
  health: null,
};
console.log(`BASE ${BASE}`);
console.log(`MODE ${COLD_MODE} SETTLE_MS ${SETTLE_MS}`);
console.log(`STAMP before ${before.commit}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};
for (const query of QUERIES) {
  const samples = [];
  let reusePage = null;
  if (COLD_MODE === "reuse") {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      locale: "en-US",
      extraHTTPHeaders: { "accept-language": "en-KW,en;q=0.9" },
    });
    await context.addCookies([{ name: "rc_refresh", value: "1", url: BASE }]);
    reusePage = await context.newPage();
    await reusePage.addInitScript(INIT_SCRIPT);
    const client = await context.newCDPSession(reusePage);
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  }
  for (let i = 0; i < SAMPLES; i++) {
    const s = COLD_MODE === "reuse" ? await loadReuse(reusePage, query) : await loadFresh(browser, query);
    samples.push(s);
    console.log(
      `  ${query} #${i + 1} firstCard=${s.firstCardMs} frame=${s.frameAt} ` +
        `responseStart=${s.nav?.responseStart ?? "?"} domContentLoaded=${s.nav?.domContentLoadedEventEnd ?? "?"} fcp=${s.nav?.fcp ?? "?"}`,
    );
    if (SETTLE_MS > 0 && i < SAMPLES - 1) await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
  if (reusePage) await reusePage.context().close();
  const paints = samples.map((s) => s.firstCardMs).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const frames = samples.map((s) => s.frameAt).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const responseStarts = samples.map((s) => s.nav?.responseStart).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const doms = samples.map((s) => s.nav?.domContentLoadedEventEnd).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const fcp = samples.map((s) => s.nav?.fcp).filter((v) => typeof v === "number").sort((a, b) => a - b);
  report[query] = {
    sortedPaints: paints,
    nulls: samples.filter((s) => s.firstCardMs === null).length,
    p50: percentile(paints, 50),
    p75: percentile(paints, 75),
    p90: percentile(paints, 90),
    sortedFrameAt: frames,
    responseStart: { min: responseStarts[0] ?? null, p50: percentile(responseStarts, 50), p75: percentile(responseStarts, 75), max: responseStarts.at(-1) ?? null },
    domContentLoaded: { min: doms[0] ?? null, p50: percentile(doms, 50), p75: percentile(doms, 75), max: doms.at(-1) ?? null },
    fcp: { min: fcp[0] ?? null, p50: percentile(fcp, 50), p75: percentile(fcp, 75), max: fcp.at(-1) ?? null },
  };
}
await browser.close();
const after = await stamp();
console.log(`STAMP after ${after.commit} health=${JSON.stringify(after.health)}`);
console.log(JSON.stringify({ stamp: { before, after }, mode: COLD_MODE, settleMs: SETTLE_MS, report }, null, 2));
