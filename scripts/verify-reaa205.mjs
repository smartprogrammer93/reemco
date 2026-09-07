/**
 * REEA-205 evidence run — merged-card check on the results route.
 *
 * Same chromium bootstrap as scripts/smoke-check.mjs (playwright-core +
 * @sparticuz/chromium + vendored NSS/sqlite libs). Queries the results page
 * with the board pair's query ("iphone 17 pro max") plus one Arabic-script
 * sample, waits the staged flushes out, then reads:
 *  - result-card count per matching product title (merge must give ONE),
 *  - the offer rows inside the merged card (both retailers, cheapest first),
 *  - the "N results" heading (must match the distinct-card count, AC-4),
 * and writes PNG screenshots + evidence JSON next to QA_EVIDENCE.
 *
 * Usage: QA_BASE_URL=http://127.0.0.1:3123 node scripts/verify-reaa205.mjs
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.QA_BASE_URL || "http://127.0.0.1:3123").replace(/\/$/, "");
const OUT = process.env.QA_EVIDENCE_DIR || "/work/task-5573f5e1-a651-4209-87c8-b336eff4f27e/scratch";

/* ---- chromium bootstrap (identical to smoke-check.mjs) ---- */
const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("./vendor/", import.meta.url);
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {
    // System chromium libs may already be present.
  }
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {
    // Optional extras when the host already provides equivalents.
  }
  process.env.LD_LIBRARY_PATH = `${LIB_DIR}:${process.env.LD_LIBRARY_PATH || ""}`;
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""]
  .filter(Boolean)
  .join(":");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");

async function probe(q, pngName, matchTitleRe) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const t0 = Date.now();
  const resp = await page.goto(`${BASE}/results?q=${encodeURIComponent(q)}`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) throw new Error(`${q}: HTTP ${resp ? resp.status() : "no response"}`);
  await page.waitForSelector(".result-card", { timeout: 25000 });
  // Wait for the converged snapshot (its h1 count is the merged distinct-
  // product count; streaming blocks appear before it). The final stage can
  // take the full collector budget (~14 s observed), so poll generously.
  await page.waitForFunction(
    () => {
      const h1 = document.querySelector("h1");
      return !!h1 && /\d/.test(h1.textContent || "");
    },
    null,
    { timeout: 60000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const read = () =>
    page.evaluate(() => {
      const cards = [...document.querySelectorAll(".result-card")].map((c) => {
        const h2 = c.querySelector("h2");
        return { title: h2 ? h2.textContent.trim() : "", text: c.textContent.replace(/\s+/g, " ").trim() };
      });
      const h1 = document.querySelector("h1");
      return { heading: h1 ? h1.textContent.trim() : "", cards };
    });
  let snap = await read();
  await new Promise((r) => setTimeout(r, 2500));
  const snap2 = await read();
  if (snap2.cards.length >= snap.cards.length) snap = snap2;
  await page.screenshot({ path: `${OUT}/${pngName}`, fullPage: false });
  const matched = snap.cards.filter((c) => matchTitleRe.test(c.title));
  // The merged card is the one carrying the most offer rows.
  const merged = [...matched].sort((a, b) => b.text.length - a.text.length)[0];
  const headingCount = snap.heading ? Number((snap.heading.match(/\d+/) || [NaN])[0]) : NaN;
  const info = {
    query: q,
    loadMs: Date.now() - t0,
    heading: snap.heading,
    headingCount,
    cardCount: snap.cards.length,
    countMatchesCards: headingCount === snap.cards.length,
    matchingCards: matched.length,
    mergedCard: merged ? { title: merged.title, cardText: merged.text } : null,
    allTitles: snap.cards.map((c) => c.title),
  };
  await page.close();
  return info;
}

const en = await probe("iphone 17 pro max", "reaa205-en.png", /iPhone 17 Pro Max.*Silver/i);
const ar = await probe("\u0622\u0641\u0648\u0646 17 \u0628\u0631\u0648 \u0645\u0627\u0643\u0633", "reaa205-ar.png", /\u0622\u0641\u0648\u0646|iPhone/i);
const evidence = { en, ar };
writeFileSync(`${OUT}/reaa205-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
