#!/usr/bin/env node
// REEA-1269 (Bet 1b, backend half) — sitemap inventory probe.
//
// Acceptance criteria this script measures, against the SERVED head:
//   S-1  /sitemap.xml lists >=200 product URLs, all absolute HTTPS on the
//        production host only.
//   S-2  every listed product URL answers 200, its <link rel="canonical">
//        equals its own path AND the product the page actually renders
//        (`data-product-id`, cross-checked against the JSON-LD sku) equals its
//        own key — one canonical key per product, no two listed URLs rendering
//        the same product. REEA-1277 added the rendered-identity assertion: a
//        self-canonical tag over a PDP body that painted another product's
//        offer set was the measured S-2 failure.
//   S-3  no /results?q= URL is counted toward the product target (the script
//        reports the results/static counts separately).
//   S-6  the sitemap stays a bounded, cacheable payload (byte size + the
//        served Cache-Control are printed).
//
// No args, no browser. Usage:
//   node scripts/reea1269-sitemap.mjs
//   node scripts/reea1269-sitemap.mjs --sample=24   # deterministic spread
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
// A cold PDP walks the live retailer funnel behind its own completion budget
// (maxDuration 45 s); on a busy box a crawl-paced probe can see one land at
// 60-80 s. A 45 s client timeout turned that into a false failure on the first
// run of this probe (63/295 "aborted", every one of which answered on retry).
const REQUEST_TIMEOUT_MS = 90000;
const NETWORK_RETRIES = 1;
const STRICT_OFFERS = process.argv.includes("--strict-offers");

const failures = [];
const throttled = [];
const networkRetries = [];

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
  } catch (err) {
    // A transport abort is not a verdict on the URL: one bounded retry, then
    // the failure is reported. Rate-limit and 5xx answers are NOT retried here
    // (they are the app's honest answer at crawl time).
    if (attempt < NETWORK_RETRIES) {
      networkRetries.push(url);
      await sleep(5000);
      return fetchText(url, attempt + 1);
    }
    throw err;
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

/* S-2 — 200 + self-canonical + the rendered product identity on every listed
 * product URL. REEA-1277 — the canonical tag alone is not enough: the PDP body
 * resolves the slug through the live fan-out and used to fall back to another
 * product when the exact id was absent from the run. The page now carries its
 * resolved identity as `data-product-id` (ProductHero root, server-rendered)
 * and the JSON-LD `sku`; both must equal the URL's own key. */
const canonicalRe = /<link[^>]*rel="canonical"[^>]*href="([^"]+)"[^>]*>/i;
const offerRowRe = /class="rc-offer-row/g;
const renderedIdRe = /data-product-id="([^"]+)"/;
const jsonLdScriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/** The product id the page itself renders (hero identity + JSON-LD sku). */
function renderedIdentity(body) {
  const attr = body.match(renderedIdRe)?.[1] || "";
  let sku = "";
  for (const match of body.matchAll(jsonLdScriptRe)) {
    try {
      const parsed = JSON.parse(match[1].replace(/\\u003c/g, "<"));
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (node && node["@type"] === "Product" && typeof node.sku === "string") {
          sku = node.sku;
          break;
        }
      }
    } catch {
      /* a malformed block is not a verdict on the page identity */
    }
    if (sku) break;
  }
  return { attr, sku };
}

/* --sample=N crawls a deterministic spread instead of the whole set; the full
 * run is the release gate. */
const sampleSize = (() => {
  const arg = process.argv.find((value) => value.startsWith("--sample="));
  const n = arg ? Number(arg.slice("--sample=".length)) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();
function sampled(urls, n) {
  if (!n || n >= urls.length) return urls;
  const out = [];
  const step = urls.length / n;
  for (let i = 0; i < n; i++) out.push(urls[Math.min(urls.length - 1, Math.floor(i * step))]);
  return [...new Set(out)];
}
const targets = sampled(products, sampleSize);
if (sampleSize) console.log(`S-2 sample — ${targets.length} of ${products.length} listed product URLs (deterministic spread)`);

const checked = [];
const zeroOffer = [];
const wrongProduct = [];
const missingIdentity = [];
let dispatchAt = 0;
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const url = targets[cursor++];
    const now = Date.now();
    const wait = Math.max(0, dispatchAt + DISPATCH_GAP_MS - now);
    dispatchAt = Math.max(now, dispatchAt + DISPATCH_GAP_MS);
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetchText(url);
      const canonical = (res.body.match(canonicalRe)?.[1] || "").replace(/&amp;/g, "&");
      const offerRows = (res.body.match(offerRowRe) || []).length;
      const { attr, sku } = renderedIdentity(res.body);
      const wantPathRaw = new URL(url).pathname;
      const wantKey = decodeURIComponent(wantPathRaw.replace(/^\/product\//, ""));
      const gotPath = canonical ? new URL(canonical).pathname : "";
      checked.push({ url, status: res.status, canonical, offerRows, rendered: attr, sku });
      if (res.status !== 200) fail("S-2", `${url} answered ${res.status}`);
      if (gotPath !== wantPathRaw) fail("S-2", `${url} canonical is ${gotPath || "<missing>"}, not itself`);
      if (!attr) {
        missingIdentity.push(url);
        fail("S-2", `${url} renders no data-product-id`);
      } else if (attr !== wantKey) {
        wrongProduct.push(`${url} → ${attr}`);
        fail("S-2", `${url} renders ${attr}, not its own key`);
      }
      if (sku && sku !== wantKey) {
        fail("S-2", `${url} JSON-LD sku is ${sku}, not its own key`);
      }
      if (offerRows === 0) zeroOffer.push(url);
    } catch (err) {
      checked.push({ url, status: 0, canonical: "", offerRows: 0, rendered: "", sku: "" });
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
const identityCount = checked.filter((c) => c.rendered && c.rendered === decodeURIComponent(new URL(c.url).pathname.replace(/^\/product\//, ""))).length;
const skuCount = checked.filter((c) => c.sku && c.sku === decodeURIComponent(new URL(c.url).pathname.replace(/^\/product\//, ""))).length;
const painted = checked.filter((c) => c.offerRows > 0).length;

/* S-2 duplicate rendered ids: two listed URLs painting one product is the thin
 * duplicate key the criterion forbids. */
const byRendered = new Map();
for (const c of checked) {
  if (!c.rendered) continue;
  const list = byRendered.get(c.rendered) ?? [];
  list.push(c.url);
  byRendered.set(c.rendered, list);
}
const duplicates = [...byRendered.entries()].filter(([, urls]) => urls.length > 1);
for (const [id, urls] of duplicates.slice(0, 10)) {
  fail("S-2", `${urls.length} listed URLs render the same product ${id}: ${urls.join(", ")}`);
}

console.log(`S-2 measured — GET 200: ${okCount}/${checked.length}, canonical self-aligned: ${selfCount}/${checked.length}`);
console.log(`S-2 rendered identity — equals own path: ${identityCount}/${checked.length}; JSON-LD sku agrees: ${skuCount}/${checked.length}; wrong product: ${wrongProduct.length}; missing marker: ${missingIdentity.length}`);
console.log(`S-2 duplicate rendered ids across the checked set: ${duplicates.length}`);
if (wrongProduct.length > 0) {
  console.log(`S-2 wrong-product URLs: ${wrongProduct.slice(0, 10).join("; ")}${wrongProduct.length > 10 ? " …" : ""}`);
}
console.log(`S-2 offer rows — pages painting >=1 row: ${painted}/${checked.length}; zero-row: ${zeroOffer.length}`);
if (zeroOffer.length > 0) {
  console.log(`S-2 zero-row URLs: ${zeroOffer.slice(0, 10).join(", ")}${zeroOffer.length > 10 ? " …" : ""}`);
  if (STRICT_OFFERS) fail("S-2", `${zeroOffer.length} listed PDPs render 0 offer rows (strict)`);
}
if (networkRetries.length > 0) {
  console.log(`transport: ${networkRetries.length} request(s) aborted at ${REQUEST_TIMEOUT_MS} ms and answered on the bounded retry`);
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
