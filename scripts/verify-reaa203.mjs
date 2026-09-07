/**
 * REEA-203 evidence run — results-card layout check on the live site.
 *
 * Same chromium bootstrap as scripts/smoke-check.mjs (playwright-core +
 * @sparticuz/chromium + vendored NSS/sqlite libs). Queries /results?q=fold7
 * at 480 / 768 / 1280 px viewports, waits the staged flushes out, then reads
 * per-card geometry for the two board-flagged defects:
 *  - Issue 1: bounding-box overlap between the large price and the
 *    "Best price" badge (.best-flag) in the price block;
 *  - Issue 2: per-retailer-row structure consistency — whether the right
 *    group (In-stock dot · price · Go to store) stays on one baseline when
 *    the left group carries the "Lowest listed price" chip vs not.
 * Writes PNG screenshots + evidence JSON next to QA_EVIDENCE.
 *
 * Usage: QA_BASE_URL=https://reemco.vercel.app node scripts/verify-reaa203.mjs
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.QA_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const OUT = process.env.QA_EVIDENCE_DIR || "/work/task-ac898ff1-4b0c-4b2d-a461-6a962897b0ae/scratch";
mkdirSync(OUT, { recursive: true });

/* ---- chromium bootstrap (identical to verify-reaa205.mjs) ---- */
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

// In-page snapshot: per-card price/badge geometry + per-retailer-row layout.
const READ = () =>
  document.querySelectorAll(".result-card").length >= 1 &&
  JSON.stringify(
    [...document.querySelectorAll(".result-card")].map((card) => {
      const h2 = card.querySelector("h2");
      const priceBlock = h2 && h2.parentElement ? h2.parentElement.querySelector("div.ml-auto") : null;
      const price = priceBlock ? priceBlock.querySelector("span.tabular") : null;
      const badge = card.querySelector(".best-flag");
      const R = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      // Intersection area of the price and badge boxes (0 when clean beside each other).
      let overlapArea = 0;
      if (price && badge) {
        const a = price.getBoundingClientRect();
        const b = badge.getBoundingClientRect();
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        overlapArea = Math.round(ix * iy);
      }
      const rows = [...card.querySelectorAll('section li')].map((li) => {
        const left = li.children[0];
        const right = li.children[1];
        const dot = right ? right.querySelector("span") : null; // StockDot wrapper
        const cells = right ? [...right.children].map(R) : [];
        return {
          merchant: left ? left.textContent.replace(/\s+/g, " ").trim().slice(0, 40) : "",
          chip: !!(left && /lowest listed/i.test(left.textContent || "")),
          left: R(left),
          right: R(right),
          cells,
          // right group on one line when its cells share the vertical band
          inline: cells.length > 0 && Math.max(...cells.map((c) => c.y)) - Math.min(...cells.map((c) => c.y)) < 14,
        };
      });
      return {
        title: h2 ? h2.textContent.replace(/\s+/g, " ").trim() : "",
        price: R(price),
        badge: R(badge),
        overlapArea,
        rows,
      };
    }),
  );

async function probe(width, pngName) {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.setViewportSize({ width, height: 900 });
  const t0 = Date.now();
  const resp = await page.goto(`${BASE}/results?q=fold7`, { waitUntil: "commit" });
  if (!resp || resp.status() !== 200) throw new Error(`${width}px: HTTP ${resp ? resp.status() : "no response"}`);
  // REEA-178 parity: first staged cards must paint well before the final
  // converged snapshot; record both timings so a regression shows up here.
  await page.waitForSelector(".result-card", { timeout: 30000 });
  const firstCardMs = Date.now() - t0;
  const earlyCardCount = await page.evaluate(() => document.querySelectorAll(".result-card").length);
  // Converged snapshot carries the numeric "N results" heading (REEA-178
  // staged flushes land before it); poll generously like verify-reaa205.
  await page
    .waitForFunction(
      () => {
        const h1 = document.querySelector("h1");
        return !!h1 && /\d/.test(h1.textContent || "");
      },
      null,
      { timeout: 60000 },
    )
    .catch(() => {});
  const convergedMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 1500));
  const cards = JSON.parse(await page.evaluate(READ));
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.screenshot({ path: `${OUT}/${pngName}`, fullPage: false });
  await page.close();
  return { width, scrollWidth, firstCardMs, earlyCardCount, convergedMs, cards };
}

const widths = [480, 768, 1280];
const evidence = { base: BASE, widths: [] };
for (const w of widths) {
  evidence.widths.push(await probe(w, `reaa203-${w}.png`));
}

// Summary verdicts.
for (const w of evidence.widths) {
  const worstOverlap = Math.max(0, ...w.cards.map((c) => c.overlapArea || 0));
  const inlineFlags = w.cards.flatMap((c) => c.rows.map((r) => `${r.chip ? "chip" : "plain"}:${r.inline ? "inline" : "wrapped"}`));
  w.verdict = { worstOverlapAreaPx2: worstOverlap, rowShapes: inlineFlags, noHorizOverflow: w.scrollWidth <= w.width + 2 };
}
writeFileSync(`${OUT}/reaa203-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(
  JSON.stringify(
    evidence.widths.map((w) => ({
      width: w.width,
      streaming: { firstCardMs: w.firstCardMs, earlyCards: w.earlyCardCount, convergedMs: w.convergedMs, finalCards: w.cards.length },
      verdict: w.verdict,
    })),
    null,
    2,
  ),
);
await browser.close();
