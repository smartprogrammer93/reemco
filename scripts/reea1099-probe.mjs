/**
 * REEA-1099 ad-hoc probe: measure the results-page card population a real
 * browser paints, the way the measurement plan defines it (results-page cards
 * with >=2 distinct named retailers / cards), and compare it with the
 * comparison_depth counters.
 *
 * Usage: BASE_URL=https://... node scripts/reea1099-probe.mjs "iphone 17 pro" "laptop"
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
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

const queries = process.argv.slice(2);
const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});

const totals = { cards: 0, multi: 0 };
for (const q of queries) {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  page.setDefaultTimeout(60000);
  await page.goto(`${BASE}/results?q=${encodeURIComponent(q)}`, { waitUntil: "load" });
  await page.waitForTimeout(12000);
  const info = await page.evaluate(() => {
    const shelfCards = [...document.querySelectorAll('[data-primary-section="true"] article.result-card')];
    const merchantSets = shelfCards.map((c) => {
      const names = [...c.querySelectorAll(".rc-retailer-name")]
        .map((n) => (n.innerText || "").trim().toLowerCase())
        .filter(Boolean);
      return [...new Set(names)];
    });
    const multi = merchantSets.filter((s) => s.length >= 2).length;
    return {
      allResultCards: document.querySelectorAll(".result-card").length,
      shelfCards: shelfCards.length,
      multi,
      relatedItems: document.querySelectorAll(".related-item").length,
      offerRows: document.querySelectorAll(".offer-row").length,
      skeletons: document.querySelectorAll(".skeleton-card").length,
      merchantsPerCard: merchantSets.map((s) => s.length),
    };
  });
  totals.cards += info.shelfCards;
  totals.multi += info.multi;
  console.log(
    JSON.stringify({ q, cards: info.shelfCards, multi: info.multi, ratio: info.shelfCards ? +(info.multi / info.shelfCards).toFixed(3) : 0, related: info.relatedItems, offerRows: info.offerRows, skeletons: info.skeletons }),
  );
  await page.close();
}
console.log(JSON.stringify({ aggregate: totals, ratio: totals.cards ? +(totals.multi / totals.cards).toFixed(3) : 0 }));
await browser.close();
