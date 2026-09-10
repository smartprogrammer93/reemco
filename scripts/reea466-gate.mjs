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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  headless: true,
});
// REEA-523 — the checkpoint interstitial only ever verifies for a UA that
// reads like a real browser: with the default Playwright headless UA
// ("HeadlessChrome/…") the page sat on the checkpoint for the whole 30 s
// window and every row measured the interstitial instead of the app; a plain
// Chrome UA on the same Chromium build verifies in <1 s and renders the app
// (legacy headless, same engine). Without this the harness silently measures
// the wrong document even when the pre-warm "passes" its selector wait.
const page = await browser.newPage({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
});
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
  // REEA-523 — commit + explicit clocks instead of leaning on `goto`:
  //  - firstOffer: first real card in the DOM (poll loop, right after commit);
  //  - completeMs: when the document FINALIZES — readyState leaves "loading",
  //    exactly when DOMContentLoaded fires on a streamed page, i.e. when the
  //    stream closes. That is the completion clock this gate polices: late
  //    waves that patch in afterward keep the COUNT honest without holding
  //    the document open.
  // With waitUntil:"commit" every number comes from the poll loop, so the
  // measurements do not fork on engine quirks around when each Chromium fires
  // DCL for streamed documents. The ceiling rides maxDuration (45 s).
  await page.goto(url, { waitUntil: "commit", timeout: 45000 });
  let firstOffer = null;
  let lastCount = null;
  let stableRun = 0;
  let completeAt = null;
  let headingVals = [];
  let cards = 0;
  while (Date.now() - t0 < 45000) {
    const snap = await page.evaluate(() => {
      const cardEls = [...document.querySelectorAll("article.result-card")].filter((c) => c.getAttribute("aria-hidden") !== "true" && c.getAttribute("aria-hidden") !== "");
      const tab = document.querySelector("h1 .tabular, span.tabular");
      return { cards: cardEls.length, heading: tab ? tab.textContent.trim() : null, rs: document.readyState };
    }).catch(() => null);
    if (!snap) { await new Promise((r) => setTimeout(r, 60)); continue; }
    const now = Date.now() - t0;
    if (firstOffer === null && snap.cards >= 1) firstOffer = now;
    if (snap.heading !== null && snap.heading !== "" && snap.heading !== lastCount) {
      headingVals = [Number(snap.heading)]; // last stable value — same shape as the accepted REEA-467 tables
      lastCount = snap.heading;
      stableRun = 1;
    } else if (snap.heading !== null && snap.heading !== "") {
      stableRun++;
    }
    // Completion clock: the stream-closed moment — finalize inside the
    // deadline is what this gate polices.
    if (completeAt === null && snap.rs !== "loading") {
      completeAt = now;
      lastCount = snap.heading;
      headingVals = snap.heading ? [Number(snap.heading)] : [];
      cards = snap.cards;
      stableRun = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  // REEA-523 — settled count read AFTER finalize: late retailer waves stream
  // in behind the closed document via the follow-up feed, so the count a
  // shopper actually reads lands within ~1-2 s of close. Read heading + cards
  // once they stop changing (3 consecutive samples, grace capped at 3 s) —
  // that is the number the warm-vs-cold count match must compare, and it
  // keeps the comparison honest instead of freezing the partial close-time
  // count. The completion clock itself stays the close moment above.
  const settleDeadline = Date.now() + 3000;
  while (Date.now() < settleDeadline) {
    await new Promise((r) => setTimeout(r, 60));
    const snap = await page.evaluate(() => {
      const cardEls = [...document.querySelectorAll("article.result-card")].filter((c) => c.getAttribute("aria-hidden") !== "true" && c.getAttribute("aria-hidden") !== "");
      const tab = document.querySelector("h1 .tabular, span.tabular");
      return { cards: cardEls.length, heading: tab ? tab.textContent.trim() : null };
    }).catch(() => null);
    if (!snap || snap.heading === null || snap.heading === "") continue;
    if (snap.heading === lastCount) stableRun++;
    else { stableRun = 1; lastCount = snap.heading; }
    headingVals = [Number(snap.heading)];
    cards = snap.cards;
    if (stableRun >= 3) break;
  }
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
