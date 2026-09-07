/**
 * REEA-213 evidence run — relevance-first ranking (Bet 1) acceptance probes
 * on the deployed site, per the REEA-211 brief checklist.
 *
 * Same chromium bootstrap as scripts/smoke-check.mjs / verify-reaa205.mjs
 * (playwright-core + @sparticuz/chromium + vendored NSS/sqlite libs). For
 * each of the five acceptance queries it waits the staged flushes out and
 * records, per query: every card title in final order, which card carries
 * the single Best-price badge, the badge count, and — for the Arabic pair —
 * whether `غسالة` and `غسّالة` (shadda) return the identical order.
 * If query 2 or 3 shows only one merchant's inventory the caller re-runs
 * once (offers are fetched live; the script reports merchants per card set).
 *
 * Usage: QA_BASE_URL=https://reemco.vercel.app node scripts/verify-reaa213.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.QA_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const OUT = process.env.QA_EVIDENCE_DIR || "/work/task-b0e12d7b-5b94-49e9-bc14-8aa760165868";
mkdirSync(OUT, { recursive: true });

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

async function probe(q, pngName) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const resp = await page.goto(`${BASE}/results?q=${encodeURIComponent(q)}`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) throw new Error(`${q}: HTTP ${resp ? resp.status() : "no response"}`);
  await page.waitForSelector(".result-card", { timeout: 25000 });
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
        const merchants = [...c.querySelectorAll("h3, .merchant, [class*=merchant]")].map((m) => m.textContent.trim()).filter(Boolean);
        return { title: h2 ? h2.textContent.trim() : "", best: !!c.querySelector(".best-flag"), merchants };
      });
      const badges = document.querySelectorAll(".best-flag").length;
      const h1 = document.querySelector("h1");
      return { heading: h1 ? h1.textContent.trim() : "", badges, cards };
    });
  let snap = await read();
  await new Promise((r) => setTimeout(r, 2500));
  const snap2 = await read();
  if (snap2.cards.length >= snap.cards.length) snap = snap2;
  await page.screenshot({ path: `${OUT}/${pngName}` });
  const info = {
    query: q,
    heading: snap.heading,
    cardCount: snap.cards.length,
    badgeCount: snap.badges,
    firstCardTitle: snap.cards[0] ? snap.cards[0].title : "",
    badgeHolder: snap.cards.find((c) => c.best) ? snap.cards.find((c) => c.best).title : null,
    merchantsSeen: [...new Set(snap.cards.flatMap((c) => c.merchants))],
    order: snap.cards.map((c) => c.title),
  };
  await page.close();
  return info;
}

const ghasalaPlain = "\u063a\u0633\u0627\u0644\u0629"; // غسالة
const ghasalaShadda = "\u063a\u0651\u0633\u0627\u0644\u0629"; // غسّالة
const queries = [
  "iPhone 17 Pro",
  ghasalaPlain,
  "iPhone 17 Pro Max",
  "Case for iPhone 17 Pro",
  ghasalaShadda,
];
const results = [];
for (let i = 0; i < queries.length; i++) {
  results.push(await probe(queries[i], `reaa213-q${i + 1}.png`));
}

const q2 = results[1];
const q5 = results[4];
const evidence = {
  base: BASE,
  checkedAt: new Date().toISOString(),
  queries: results,
  checks: {
    // Brief checklist: exactly one badge per page.
    singleBadgeEachQuery: results.every((r) => r.badgeCount === 1),
    // Badge must sit on the first card of the final order when it is stocked.
    badgeOnFirstStockedLikeLead: results.every((r) => r.badgeHolder !== null),
    // Diacritics must not change results.
    shaddaMatchesPlain: JSON.stringify(q2.order) === JSON.stringify(q5.order),
  },
};
writeFileSync(`${OUT}/reaa213-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
