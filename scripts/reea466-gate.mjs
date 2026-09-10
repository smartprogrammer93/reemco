/**
 * REEA-466 gate harness — browser-based so the Vercel security checkpoint
 * verifies and timings reflect the served app, not the interstitial.
 * Launch/bootstrap follows scripts/smoke-check.mjs (playwright-core +
 * @sparticuz/chromium, vendored NSS/sqlite extras, --headless=new).
 *
 * Per round: one cold navigation per query (punctuation-suffixed variant per
 * round — tokenizer drops punctuation-only tokens, memo key folds only
 * trim+lowercase, so each round walks live while answering the same shopper
 * query), then an immediate warm repeat of the exact same string (fresh-window
 * memo path). Measures: firstOffer (first real card in DOM), complete (heading
 * count present and stable over 3 consecutive samples), heading count values +
 * card count for the warm-match comparison.
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = "https://reemco.vercel.app";
const QUERIES = ["iPhone 17 Pro", "samsung galaxy s25 fe", "Scope II keyboard", "\u0622\u064a\u0641\u0648\u0646 17", "zzqx vbnt"];
const SUFFIX = ["", ".", "..", "...", "...."];

const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    writeFileSync("/tmp/al2023.tar", brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))));
    execSync("mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023");
  } catch {}
}
if (existsSync(LIB_DIR)) {
  try { execSync(`cp -f scripts/vendor/libsqlite3.so.0 scripts/vendor/libc.musl-x86_64.so.1 scripts/vendor/libnssckbi.so ${LIB_DIR}/`); } catch {}
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(30000);

// Pre-warm: clear the security checkpoint outside measured navigations.
await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 30000 });
await page.waitForSelector("header a[href='/']", { timeout: 15000 }).catch(() => {});

const stamp = await page.evaluate(async () => {
  const r = await fetch("/__commit.txt");
  return (await r.text()).trim();
}).catch(() => "stamp-fetch-failed");
console.log("STAMP " + stamp);

async function measure(q) {
  const url = `${BASE}/results?q=${encodeURIComponent(q)}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  let firstOffer = null;
  let lastCount = null;
  let stableRun = 0;
  let completeAt = null;
  let headingVals = [];
  let cards = 0;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const cardEls = [...document.querySelectorAll("article.result-card")].filter((c) => c.getAttribute("aria-hidden") !== "true" && c.getAttribute("aria-hidden") !== "");
      const tab = document.querySelector("h1 .tabular, span.tabular");
      return { cards: cardEls.length, heading: tab ? tab.textContent.trim() : null, title: document.title };
    }).catch(() => null);
    if (!snap) { await new Promise((r) => setTimeout(r, 60)); continue; }
    const now = Date.now() - t0;
    if (firstOffer === null && snap.cards >= 1) firstOffer = now;
    if (snap.heading !== null && snap.heading !== "") {
      if (snap.heading === lastCount) stableRun++;
      else { stableRun = 1; lastCount = snap.heading; headingVals = [Number(snap.heading)]; }
      if (completeAt === null && stableRun >= 3 && firstOffer !== null) { completeAt = now; cards = snap.cards; }
    }
    if (completeAt !== null) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  if (completeAt === null && lastCount !== null) { completeAt = Date.now() - t0; }
  return { firstOffer, completeMs: completeAt, headingVals, cards };
}

const rows = [];
for (let round = 0; round < 5; round++) {
  for (const baseQ of QUERIES) {
    const q = baseQ + SUFFIX[round];
    const cold = await measure(q);
    const warm = await measure(q);
    rows.push({ round: round + 1, q: baseQ, cold, warm });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
}
const p75 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.ceil(0.75 * s.length) - 1]; };
console.log("SUMMARY " + JSON.stringify({
  stamp,
  coldCompleteP75_all: p75(rows.map((r) => r.cold.completeMs ?? 99999)),
  warmCompleteP75_all: p75(rows.map((r) => r.warm.completeMs ?? 99999)),
  perQuery: QUERIES.map((q) => {
    const rs = rows.filter((r) => r.q === q);
    return {
      q,
      coldComplete: rs.map((r) => r.cold.completeMs),
      firstOffer: rs.map((r) => r.cold.firstOffer),
      foLe2000: rs.filter((r) => r.cold.firstOffer !== null && r.cold.firstOffer <= 2000).length + "/5",
      warmComplete: rs.map((r) => r.warm.completeMs),
      warmLe1500: rs.filter((r) => r.warm.completeMs !== null && r.warm.completeMs <= 1500).length + "/5",
      countsMatch: rs.map((r) => (JSON.stringify(r.cold.headingVals) === JSON.stringify(r.warm.headingVals) && r.cold.cards === r.warm.cards ? "=" : `${JSON.stringify(r.cold.headingVals)}/${r.cold.cards}!=${JSON.stringify(r.warm.headingVals)}/${r.warm.cards}`)),
    };
  }),
}));
await browser.close();
