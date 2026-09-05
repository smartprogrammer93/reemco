/**
 * REEA-44 post-deploy smoke check.
 *
 * Verifies the minimal funnel end-to-end against the deployed site:
 *   step 1: home page loads (HTTP 200, no fatal render error)
 *   step 2: a stable fixture query returns real result cards
 *   step 3: at least one card renders a working click-out link
 *
 * Deterministic: the fixture query hits the seeded catalog shipped with the
 * app bundle, never fresh scraping data. Runs headless (playwright-core +
 * @sparticuz/chromium), well under 2 minutes.
 *
 * Usage: SMOKE_BASE_URL=https://<deploy> node scripts/smoke-check.mjs
 * Exit 0 = SMOKE PASSED, exit 1 = SMOKE FAILED (names the failed step).
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco-price-compare-preview.surge.sh").replace(/\/$/, "");
// Stable fixture: "sony" matches seeded catalog products deterministically.
const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";

const results = [];
function step(n, name, fn) {
  return fn().then(
    (detail) => {
      results.push(`  PASS step ${n}: ${name}${detail ? ` — ${detail}` : ""}`);
    },
    (err) => {
      console.error(`SMOKE FAILED at step ${n} (${name}): ${err.message}`);
      console.error(`Deploy under test: ${BASE}`);
      console.error("SMOKE FAILED — deploy must be treated as failed / rolled back. See step above.");
      process.exit(1);
    },
  );
}

// @sparticuz/chromium bundles its shared libraries (libnspr4 etc.) in
// al2023.tar.br but only wires them up on Amazon Linux. Extract them and point
// LD_LIBRARY_PATH at the result before spawning the browser.
const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {
    // System chromium libs may already be present (e.g. GitHub runners).
  }
}
if (existsSync(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${LIB_DIR}:${process.env.LD_LIBRARY_PATH}`
    : LIB_DIR;
}

const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(30000);

await step(1, "home page loads (200, no fatal render error)", async () => {
  const resp = await page.goto(`${BASE}/`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) throw new Error(`home returned HTTP ${resp ? resp.status() : "no response"}`);
  await page.waitForSelector("header a[href='/']", { timeout: 15000 });
  const fatal = await page.$("text=/Application error|Unhandled Runtime Error/i");
  if (fatal) throw new Error("home page rendered a fatal error boundary");
  return `HTTP 200, app shell rendered`;
});

await step(2, `search "${FIXTURE_QUERY}" returns results`, async () => {
  const resp = await page.goto(`${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) throw new Error(`results returned HTTP ${resp ? resp.status() : "no response"}`);
  // Wait out client-side hydration: real cards replace the aria-hidden skeletons.
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll(".result-card")];
      return cards.some((c) => c.getAttribute("aria-hidden") !== "true" && c.querySelector("a[href]"));
    },
    { timeout: 25000 },
  );
  const count = await page.$$eval(".result-card", (cards) => cards.filter((c) => c.getAttribute("aria-hidden") !== "true" && c.querySelector("a[href]")).length);
  if (count < 1) throw new Error("no real result card rendered (only skeletons / empty state)");
  return `${count} result card(s) rendered`;
});

await step(3, "result card has a working click-out link", async () => {
  const productHref = await page.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  const offerHref = await page.$(".result-card a[target='_blank'][rel*='noopener'], .result-card a[href^='http']");
  if (!productHref && !offerHref) throw new Error("no click-out link (product or offer) on the result card");
  if (productHref) {
    const resp = await page.goto(`${BASE}${productHref}`, { waitUntil: "load" });
    if (!resp || resp.status() !== 200) throw new Error(`product page ${productHref} returned HTTP ${resp ? resp.status() : "no response"}`);
    return `product page ${productHref} resolves HTTP 200${offerHref ? " (+ offer link present)" : ""}`;
  }
  return `offer link ${await offerHref.getAttribute("href")} present on card`;
});

await browser.close();
console.log(results.join("\n"));
console.log(`SMOKE PASSED — ${BASE} funnel (home → search → click-out) is healthy.`);
