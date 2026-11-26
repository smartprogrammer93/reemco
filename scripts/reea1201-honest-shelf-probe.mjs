/**
 * REEA-1201 (Bet 7A-2) — honest-shelf probe.
 *
 * Measures the SERVED results page at 375/1280 in EN and AR, light theme, for
 * the Bet 7A panel (panadol, cucumber, samsung galaxy s25 ultra, laptop) plus
 * the Bet 6 panel (iphone 17 pro) used for the before/after arithmetic record:
 *   - page-level horizontal overflow (documentElement.scrollWidth vs innerWidth)
 *   - primary shelf card count (the rendered primary-scope cards)
 *   - the in-scope count line text and its data-in-scope-total
 *   - the labelled accessory band (label, item count, document position)
 *   - the thin-shelf honesty line
 *   - the Bet 6 card arithmetic: first-card price, savings chip, retailer
 *     count/basis, offer rows, coupon badges, coverage line
 *   - screenshots per viewport/locale
 *
 * Usage:
 *   BASE_URL=https://ns539626.ip-144-217-72.net OUT=/tmp/reea1201-before.json \
 *     SHOTS=/tmp/reea1201-before-shots node scripts/reea1201-honest-shelf-probe.mjs
 *
 * No arguments required beyond the env above; QA can run it as-is.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1201-probe.json";
const SHOTS = process.env.SHOTS || "/tmp/reea1201-shots";
const LOCALES = (process.env.LOCALES || "en,ar").split(",").filter(Boolean);
const WIDTHS = (process.env.WIDTHS || "375,1280").split(",").map(Number).filter(Boolean);
const QUERIES = (process.env.QUERIES || "panadol,cucumber,samsung galaxy s25 ultra,laptop,iphone 17 pro")
  .split(",")
  .map((q) => q.trim())
  .filter(Boolean);
mkdirSync(SHOTS, { recursive: true });

const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("./vendor/", import.meta.url);
if (!existsSync(LIB_DIR)) {
  try {
    writeFileSync(
      "/tmp/al2023.tar",
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023`);
  } catch {
    /* system chromium libs may already exist */
  }
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {
    /* vendored extras are optional */
  }
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""]
  .filter(Boolean)
  .join(":");

const stamp = await fetch(`${BASE}/__commit.txt`).then((r) => r.text()).catch(() => null);
const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`served stamp: ${stamp}`);
console.log(`health: ${JSON.stringify(health)}`);

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});

const results = [];
for (const query of QUERIES) {
  for (const width of WIDTHS) {
    for (const locale of LOCALES) {
      const ctx = await browser.newContext({
        viewport: { width, height: width === 375 ? 812 : 900 },
        locale: locale === "ar" ? "ar-KW" : "en-KW",
        colorScheme: "light",
      });
      if (locale === "ar") await ctx.addCookies([{ name: "rc_locale", value: "ar", url: BASE }]);
      const page = await ctx.newPage();
      const url = `${BASE}/results?q=${encodeURIComponent(query)}&market=KW`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForSelector("article.rc-card", { timeout: 120000 }).catch(() => null);
      await page.waitForTimeout(3000);
      const data = await page.evaluate(() => {
        const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
        const doc = document.documentElement;
        const primarySection = document.querySelector("[data-primary-section]");
        const accessory = document.querySelector("[data-accessory-band]");
        const thin = document.querySelector("[data-thin-shelf]");
        const countLine = document.querySelector("[data-in-scope-count]");
        const first = document.querySelector("article.rc-card");
        const order = Array.from(
          document.querySelectorAll("[data-primary-section], [data-accessory-band], [data-related-band]"),
        ).map((el) =>
          el.hasAttribute("data-primary-section")
            ? "primary"
            : el.hasAttribute("data-accessory-band")
              ? "accessory"
              : "related",
        );
        const rectOf = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, height: r.height };
        };
        return {
          innerWidth: window.innerWidth,
          scrollWidth: doc.scrollWidth,
          overflow: doc.scrollWidth > window.innerWidth + 1,
          primaryCards: primarySection ? primarySection.querySelectorAll("article.rc-card").length : 0,
          countLineText: norm(countLine?.textContent),
          countLineTotal: countLine?.getAttribute("data-in-scope-total") ?? null,
          countLineRect: rectOf(countLine),
          thinShelfText: norm(thin?.textContent),
          thinShelfRect: rectOf(thin),
          accessoryBandPresent: !!accessory,
          accessoryLabel: norm(accessory?.querySelector(".related-band-title")?.textContent),
          accessoryItems: accessory ? accessory.querySelectorAll("[data-accessory-item]").length : 0,
          accessoryRect: rectOf(accessory),
          sectionOrder: order,
          metaText: norm(document.querySelector(".rc-results-meta")?.textContent),
          firstCard: first
            ? {
                title: norm(first.querySelector(".rc-card-title")?.textContent),
                basis: norm(first.querySelector(".rc-card-basis")?.textContent),
                price: norm(first.querySelector(".rc-price-card")?.textContent),
                was: norm(first.querySelector(".rc-price-was")?.textContent),
                savings: norm(first.querySelector(".rc-savings")?.textContent),
                offerRows: first.querySelectorAll("li.offer-row").length,
                coupons: first.querySelectorAll(".coupon-badge, .coupon-line").length,
              }
            : null,
          coverageLine: norm(document.querySelector(".coverage-line")?.textContent),
        };
      });
      await page.screenshot({ path: `${SHOTS}/${query.replace(/[^a-z0-9]+/gi, "_")}-${width}-${locale}.png`, fullPage: false });
      results.push({ query, width, locale, url, stamp, health, ...data });
      console.log(
        `${query} ${width}/${locale}: primary=${data.primaryCards} count="${data.countLineText}" accessory=${data.accessoryBandPresent ? data.accessoryItems : 0} thin="${data.thinShelfText}" overflow=${data.overflow}`,
      );
      await ctx.close();
    }
  }
}
await browser.close();
writeFileSync(OUT, JSON.stringify({ stamp, health, results }, null, 2));
const bad = results.filter((r) => r.overflow);
if (bad.length) {
  console.error("FAIL: page-level horizontal overflow", bad.map((r) => `${r.query} ${r.width}/${r.locale}`));
  process.exit(1);
}
console.log(`OK: no horizontal overflow across ${results.length} runs; wrote ${OUT}`);
