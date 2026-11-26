/**
 * REEA-1177 — shelf integrity probe. Measures the SERVED results page at
 * 375/1280 in EN and AR for the Bet 6a acceptance surface:
 *   - horizontal overflow (documentElement.scrollWidth vs innerWidth)
 *   - the visible composition line (.rc-price-composition) inside the viewport
 *   - first card text (headline, saving statement, coupon statement)
 *   - any .coupon-badge on the page
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3011 QUERY='iphone 17 pro' OUT=/tmp/reea1177.json \
 *     SHOTS=/tmp/reea1177-shots node scripts/reea1177-probe.mjs
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3011").replace(/\/$/, "");
const QUERY = process.env.QUERY || "iphone 17 pro";
const OUT = process.env.OUT || "/tmp/reea1177.json";
const SHOTS = process.env.SHOTS || "/tmp/reea1177-shots";
const LOCALES = (process.env.LOCALES || "en,ar").split(",").filter(Boolean);
const WIDTHS = (process.env.WIDTHS || "375,1280").split(",").map(Number).filter(Boolean);
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

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});

const results = [];
for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 375 ? 812 : 900 },
      locale: locale === "ar" ? "ar-KW" : "en-KW",
      colorScheme: "light",
    });
    if (locale === "ar") await ctx.addCookies([{ name: "rc_locale", value: "ar", url: BASE }]);
    const page = await ctx.newPage();
    const url = `${BASE}/results?q=${encodeURIComponent(QUERY)}&market=KW`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("article.rc-card", { timeout: 120000 }).catch(() => null);
    await page.waitForTimeout(2500);
    const data = await page.evaluate(() => {
      const doc = document.documentElement;
      const first = document.querySelector("article.rc-card");
      const comps = Array.from(document.querySelectorAll(".rc-price-composition"));
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, height: r.height };
      };
      return {
        innerWidth: window.innerWidth,
        scrollWidth: doc.scrollWidth,
        overflow: doc.scrollWidth > window.innerWidth + 1,
        firstCard: first ? (first.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600) : null,
        compositionCount: comps.length,
        compositions: comps.slice(0, 4).map((el) => ({
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
          rect: rect(el),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          clipped: el.scrollWidth > el.clientWidth + 1,
        })),
        couponBadges: Array.from(document.querySelectorAll(".coupon-badge")).map((el) =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
        couponLines: Array.from(document.querySelectorAll(".coupon-line")).map((el) =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
        offerRows: document.querySelectorAll("li.offer-row").length,
        marketBadges: Array.from(document.querySelectorAll(".rc-market-badge")).map((el) =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
      };
    });
    await page.screenshot({ path: `${SHOTS}/${width}-${locale}.png`, fullPage: false });
    results.push({ width, locale, url, ...data });
    await ctx.close();
  }
}
await browser.close();
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.overflow || r.compositions.some((c) => c.clipped));
if (bad.length) {
  console.error("FAIL: overflow or clipped composition", bad.map((r) => `${r.width}/${r.locale}`));
  process.exit(1);
}
