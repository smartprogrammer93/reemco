#!/usr/bin/env node
/**
 * REEA-1147 — the Bet 4.1 fixed exact-model panel, measured on a real 375px
 * browser: iphone 17 pro / fold 7 / samsung galaxy s25 ultra, EN and AR.
 *
 * AC1 asks for the share of RENDERED shelf cards that carry >=2 distinct
 * in-market (KWD) retailers, on a dedup-corrected denominator (unique
 * productId, not rendered <article> count). The page itself is the honest
 * oracle: since REEA-1147 AC2 a card only prints the "best effective price"
 * basis when it has >=2 distinct retailers in the surface's market (home
 * Kuwait by default), and prints "N retailer(s)" otherwise. So the measure
 * reads the rendered basis, never the retailer-row count (which can include
 * labelled cross-market rows).
 *
 * Usage:
 *   node scripts/reea1147-depth-panel.mjs [baseUrl]
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.argv[2] || process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.DEPTH_OUT || "reea1147-depth-panel.json";

// This container: @sparticuz/chromium needs the extracted al2023 libs + sqlite
// shim on LD_LIBRARY_PATH, HOME=/tmp, FONTCONFIG_PATH (same bootstrap the other
// probes in this repo use).
const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {}
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const QUERIES = ["iphone 17 pro", "fold 7", "samsung galaxy s25 ultra"];
const LOCALES = [
  { code: "en", bestEffective: "best effective price", retailerOne: "1 retailer" },
  { code: "ar", bestEffective: "أفضل سعر فعلي", retailerOne: "1 متجر" },
];

async function stamp() {
  try {
    const res = await fetch(`${BASE}/__commit.txt`, { signal: AbortSignal.timeout(15_000) });
    return (await res.text()).trim();
  } catch (err) {
    return `unreadable: ${String(err)}`;
  }
}

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");

const rows = [];
const totals = { cards: 0, unique: 0, multi: 0, oneRetailer: 0, savingsOnOne: 0 };
for (const q of QUERIES) {
  for (const loc of LOCALES) {
    const buildStamp = await stamp();
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await ctx.addCookies([{ name: "rc_locale", value: loc.code, url: BASE }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(90_000);
    const started = Date.now();
    await page.goto(`${BASE}/results?q=${encodeURIComponent(q)}`, { waitUntil: "load" });
    // Let the staged feed CONVERGE, not just first-paint: the shelf count must
    // stay unchanged for 5 consecutive seconds after at least 8 s, so an early
    // flush cannot be mistaken for the settled page (the first-flush boundary
    // paints before the follow-up fold lands).
    const countCards = () =>
      page.evaluate(() => {
        const shelf = document.querySelector('[data-primary-section="true"]');
        return shelf ? shelf.querySelectorAll("article.result-card").length : 0;
      });
    let stableSince = null;
    let last = -1;
    const t0 = Date.now();
    while (Date.now() - t0 < 40_000) {
      await page.waitForTimeout(1_000);
      const n = await countCards();
      if (n !== last) {
        last = n;
        stableSince = Date.now();
        continue;
      }
      if (n > 0 && Date.now() - t0 >= 8_000 && stableSince != null && Date.now() - stableSince >= 5_000) break;
    }
    const info = await page.evaluate(
      ({ bestEffective, retailerOne }) => {
        const shelf = document.querySelector('[data-primary-section="true"]');
        const cards = shelf ? [...shelf.querySelectorAll("article.result-card")] : [];
        const seen = new Map();
        for (const c of cards) {
          const href = c.querySelector('a[href^="/product/"]')?.getAttribute("href") || "";
          const m = /\/product\/([^/?#]+)/.exec(href);
          const productId = m ? decodeURIComponent(m[1]) : "";
          const basis = (c.querySelector(".rc-card-basis")?.textContent || "").trim();
          const savings = c.querySelector(".rc-savings")?.textContent?.trim() || "";
          const comparison = basis.includes(bestEffective);
          const single = basis.includes(retailerOne);
          const prev = seen.get(productId || `card-${seen.size}`);
          if (prev) {
            prev.renders += 1;
            prev.comparison = prev.comparison || comparison;
          } else {
            seen.set(productId || `card-${seen.size}`, { comparison, single, savings, renders: 1 });
          }
        }
        return {
          renderedCards: cards.length,
          unique: seen.size,
          multi: [...seen.values()].filter((v) => v.comparison).length,
          oneRetailer: [...seen.values()].filter((v) => v.single).length,
          savingsOnOne: [...seen.values()].filter((v) => v.single && v.savings !== "").length,
          basisSamples: [...seen.values()].slice(0, 8).map((v) => (v.comparison ? bestEffective : v.single ? retailerOne : "other")),
        };
      },
      { bestEffective: loc.bestEffective, retailerOne: loc.retailerOne },
    );
    const elapsed = Date.now() - started;
    totals.cards += info.renderedCards;
    totals.unique += info.unique;
    totals.multi += info.multi;
    totals.oneRetailer += info.oneRetailer;
    totals.savingsOnOne += info.savingsOnOne;
    const row = {
      q,
      locale: loc.code,
      stamp: buildStamp,
      elapsedMs: elapsed,
      renderedCards: info.renderedCards,
      uniqueProductIds: info.unique,
      multiRetailerCards: info.multi,
      oneRetailerCards: info.oneRetailer,
      savingsOnOneRetailer: info.savingsOnOne,
      depth: info.unique ? +(info.multi / info.unique).toFixed(3) : 0,
      basisSamples: info.basisSamples,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    await ctx.close();
  }
}
const depth = totals.unique ? +(totals.multi / totals.unique).toFixed(3) : 0;
const report = {
  base: BASE,
  measuredAt: new Date().toISOString(),
  stamp: await stamp(),
  panel: rows,
  aggregate: { ...totals, depth, gate: 0.4, pass: depth >= 0.4 },
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ aggregate: report.aggregate, out: OUT }));
await browser.close();
