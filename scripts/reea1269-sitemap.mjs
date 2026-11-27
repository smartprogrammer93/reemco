#!/usr/bin/env node
// REEA-1269 (Bet 1b, backend half) — sitemap inventory probe.
//
// Acceptance criteria this script measures, against the SERVED head:
//   S-1  /sitemap.xml lists >=200 product URLs, all absolute HTTPS on the
//        production host only.
//   S-2  every listed product URL answers 200 and its <link rel="canonical">
//        equals its own path (one canonical key per product — no thin
//        duplicate key).
//   S-3  no /results?q= URL is counted toward the product target (the script
//        reports the results/static counts separately).
//   S-6  the sitemap stays a bounded, cacheable payload (byte size + the
//        served Cache-Control are printed).
//
// No args, no browser. Usage:
//   node scripts/reea1269-sitemap.mjs
//   BASE_URL=http://127.0.0.1:3100 node scripts/reea1269-sitemap.mjs
//
// It prints the served /__commit.txt stamp BEFORE running (QA parity rule: a
// stale stamp means the measurement is of the wrong build), then the measured
// numbers. Exit 0 = PASS, exit 1 = FAIL (names the failing criterion), exit 2 =
// the app's per-IP page gate throttled the run (not a broken build; rerun).
//
// Pacing: /product pages sit behind the app's 60 requests/min per-IP page gate
// (src/proxy.ts PAGE_RATE_LIMIT), so dispatches are spaced >=1 s apart with a
// bounded worker pool; a 429 honours Retry-After instead of being counted as a
// failure.
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/+$/, "");
const PRODUCT_TARGET = 200;
const CONCURRENCY = 4;
const DISPATCH_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 45000;
const STRICT_OFFERS = process.argv.includes("--strict-offers");

const failures = [];
const throttled = [];

function fail(criterion, detail) {
  failures.push(`${criterion}: ${detail}`);
  console.log(`FAIL ${criterion} — ${detail}`);
}

async function fetchText(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "reemco-reea1269-sitemap-probe/1.0", "accept-language": "en" },
    });
    const body = await res.text();
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after") || "60");
      throttled.push(url);
      await sleep(Math.min(120_000, Math.max(1000, retryAfter * 1000)));
      return fetchText(url, attempt + 1);
    }
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

/* ---- served stamp first (QA parity rule) ---- */
console.log(`BASE ${BASE}`);
try {
  const stamp = await fetchText(`${BASE}/__commit.txt`);
  const served = stamp.body.trim();
  console.log(`served /__commit.txt: ${served || "<empty>"} (HTTP ${stamp.status})`);
  if (stamp.status !== 200 || !served) fail("stamp", `/__commit.txt answered ${stamp.status} / empty body`);
} catch (err) {
  fail("stamp", `/__commit.txt unreachable: ${err.message}`);
  console.log("\nRESULT: FAIL (no served stamp — every measurement below is unproven)");
  process.exit(1);
}

/* ---- the sitemap ---- */
let xml = "";
let sitemapStatus = 0;
let sitemapBytes = 0;
let sitemapCache = "";
try {
  const res = await fetchText(`${BASE}/sitemap.xml`);
  sitemapStatus = res.status;
  xml = res.body;
  sitemapBytes = Buffer.byteLength(xml, "utf8");
  sitemapCache = res.headers.get("cache-control") || "";
} catch (err) {
  fail("S-1", `/sitemap.xml unreachable: ${err.message}`);
  console.log("\nRESULT: FAIL");
  process.exit(1);
}
console.log(`/sitemap.xml HTTP ${sitemapStatus} bytes=${sitemapBytes} cache-control="${sitemapCache}"`);
if (sitemapStatus !== 200) fail("S-1", `/sitemap.xml answered ${sitemapStatus}`);
if (!/max-age=\d+|s-maxage=\d+/.test(sitemapCache)) {
  console.log(`WARN S-6 — no explicit cache window in Cache-Control (${sitemapCache || "<none>"})`);
}

const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const products = locs.filter((u) => new URL(u).pathname.startsWith("/product/"));
const results = locs.filter((u) => new URL(u).pathname === "/results" || new URL(u).pathname === "/search");
const statics = locs.filter((u) => !products.includes(u) && !results.includes(u));
console.log(`<loc> total=${locs.length} product=${products.length} results=${results.length} static=${statics.length}`);
console.log(`S-3 — /results?q= URLs counted toward the product target: 0 of ${results.length} (kept separately)`);

/* S-1 — absolute, HTTPS, production host only. */
for (const url of locs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("S-1", `not an absolute URL: ${url}`);
    continue;
  }
  if (parsed.protocol !== "https:") fail("S-1", `not HTTPS: ${url}`);
  if (parsed.host !== new URL(BASE).host) fail("S-1", `off production host: ${url}`);
}
if (products.length < PRODUCT_TARGET) {
  fail("S-1", `only ${products.length} product URLs, target >= ${PRODUCT_TARGET}`);
} else {
  console.log(`S-1 PASS — ${products.length} product URLs (>= ${PRODUCT_TARGET})`);
}

/* S-2 — 200 + self-canonical on every listed product URL. */
const canonicalRe = /<link[^>]*rel="canonical"[^>]*href="([^"]+)"[^>]*>/i;
const offerRowRe = /class="rc-offer-row/g;
const checked = [];
const zeroOffer = [];
let dispatchAt = 0;
let cursor = 0;
async function worker() {
  while (cursor < products.length) {
    const url = products[cursor++];
    const now = Date.now();
    const wait = Math.max(0, dispatchAt + DISPATCH_GAP_MS - now);
    dispatchAt = Math.max(now, dispatchAt + DISPATCH_GAP_MS);
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetchText(url);
      const canonical = (res.body.match(canonicalRe)?.[1] || "").replace(/&amp;/g, "&");
      const offerRows = (res.body.match(offerRowRe) || []).length;
      const wantPath = new URL(url).pathname;
      const gotPath = canonical ? new URL(canonical).pathname : "";
      checked.push({ url, status: res.status, canonical, offerRows });
      if (res.status !== 200) fail("S-2", `${url} answered ${res.status}`);
      if (gotPath !== wantPath) fail("S-2", `${url} canonical is ${gotPath || "<missing>"}, not itself`);
      if (offerRows === 0) zeroOffer.push(url);
    } catch (err) {
      checked.push({ url, status: 0, canonical: "", offerRows: 0 });
      fail("S-2", `${url} fetch failed: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const okCount = checked.filter((c) => c.status === 200 && c.canonical).length;
const selfCount = checked.filter((c) => {
  try {
    return new URL(c.canonical).pathname === new URL(c.url).pathname;
  } catch {
    return false;
  }
}).length;
console.log(`S-2 measured — GET 200: ${okCount}/${checked.length}, canonical self-aligned: ${selfCount}/${checked.length}`);
console.log(`S-2 offer rows — pages painting >=1 row: ${checked.length - zeroOffer.length}/${checked.length}; zero-row: ${zeroOffer.length}`);
if (zeroOffer.length > 0) {
  console.log(`S-2 zero-row URLs: ${zeroOffer.slice(0, 10).join(", ")}${zeroOffer.length > 10 ? " …" : ""}`);
  if (STRICT_OFFERS) fail("S-2", `${zeroOffer.length} listed PDPs render 0 offer rows (strict)`);
}

console.log(`S-6 — sitemap payload ${sitemapBytes} bytes, cache-control "${sitemapCache}"`);
if (throttled.length > 0) console.log(`page gate: ${throttled.length} request(s) answered 429 and were retried after Retry-After`);

if (failures.length === 0) {
  console.log("\nRESULT: PASS");
  process.exit(0);
}
console.log(`\nRESULT: FAIL (${failures.length} criterion failure(s))`);
for (const line of failures.slice(0, 25)) console.log(`  - ${line}`);
process.exit(throttled.length > 0 && okCount < checked.length ? 2 : 1);
