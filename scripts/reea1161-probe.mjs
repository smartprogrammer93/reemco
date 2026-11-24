/**
 * REEA-1161 — 375px cross-market labels clipped in the offer row.
 *
 * Measures the SERVED /search?q=panadol page (live or local) at 375 and 1280,
 * EN and AR:
 *   - every .rc-offer-line.line-a .label-token (clientWidth/scrollWidth,
 *     rendered text, line count) and whether it is clipped
 *   - the market badges specifically (rc-market-badge / known market strings)
 *   - documentElement.scrollWidth vs innerWidth (horizontal overflow)
 *   - retailer name / stock dot / price still visible in every row
 *   - screenshots per viewport + locale
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3011 QUERY=panadol OUT=/work/.../before.json \
 *     SHOTS=/work/.../shots node scripts/reea1161-probe.mjs
 *
 * Exits non-zero when a hard success-condition gate fails.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3011").replace(/\/$/, "");
const QUERY = process.env.QUERY || "panadol";
const OUT = process.env.OUT || "/tmp/reea1161.json";
const SHOTS = process.env.SHOTS || "/tmp/reea1161-shots";
const TARGET_PATH = process.env.TARGET_PATH || `/search?q=${encodeURIComponent(process.env.QUERY || "panadol")}`;
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

const MARKET_STRINGS = ["Saudi price", "KSA stock", "سعر السعودية", "مخزون السعودية"];

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
    if (locale === "ar") {
      await ctx.addCookies([{ name: "rc_locale", value: "ar", url: BASE }]);
    }
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    let navError = null;
    try {
      await page.goto(`${BASE}${TARGET_PATH}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForSelector(".rc-offer-line.line-a .label-token", { timeout: 60000 });
      // Let the streamed/live rows settle before measuring.
      await page.waitForTimeout(1500);
    } catch (e) {
      navError = String(e).slice(0, 300);
    }

    const data = await page.evaluate((marketStrings) => {
      const rows = [...document.querySelectorAll(".rc-offer-row")];
      const tokens = [];
      for (const row of rows) {
        const lineA = row.querySelector(".rc-offer-line.line-a");
        if (!lineA) continue;
        const rowRect = row.getBoundingClientRect();
        const retailer = row.querySelector(".rc-retailer-name");
        const stock = row.querySelector(".rc-stock");
        const price = row.querySelector(".rc-price-sm");
        for (const el of lineA.querySelectorAll(".label-token")) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          tokens.push({
            text,
            market: marketStrings.includes(text),
            cls: el.className,
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            width: Math.round(r.width * 10) / 10,
            height: Math.round(r.height * 10) / 10,
            lines: lh > 0 ? Math.round((r.height / lh) * 10) / 10 : null,
            overflowX: cs.overflowX,
            whiteSpace: cs.whiteSpace,
            textOverflow: cs.textOverflow,
            flex: cs.flex,
            clipped: el.scrollWidth > el.clientWidth + 1,
            rowTop: Math.round(rowRect.top),
          });
        }
      }
      const market = tokens.filter((t) => t.market);
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0;
      };
      return {
        rowCount: rows.length,
        tokens,
        marketCount: market.length,
        marketClipped: market.filter((t) => t.clipped).length,
        marketMissingText: market.filter((t) => !t.text).length,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        rows: rows.map((row) => ({
          retailerVisible: visible(row.querySelector(".rc-retailer-name")),
          stockDotVisible: visible(row.querySelector(".rc-stock .dot")),
          priceVisible: visible(row.querySelector(".rc-price-sm")),
          rowHeight: Math.round(row.getBoundingClientRect().height),
          rowWidth: Math.round(row.getBoundingClientRect().width),
          lineAChildren: [...(row.querySelector(".rc-offer-line.line-a")?.children ?? [])].map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              tag: el.tagName,
              cls: String(el.className).slice(0, 60),
              text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
              x: Math.round(r.left),
              w: Math.round(r.width),
              flex: cs.flex,
              ws: cs.whiteSpace,
            };
          }),
        })),
        bodyFont: getComputedStyle(document.body).fontFamily,
      };
    }, MARKET_STRINGS);

    const shot = `${SHOTS}/reea1161-${width}-${locale}.png`;
    try {
      await page.screenshot({ path: shot, fullPage: false });
    } catch {
      /* screenshot is evidence only */
    }
    results.push({ width, locale, navError, shot, ...data });
    await ctx.close();
  }
}
await browser.close();

const report = { base: BASE, query: QUERY, at: new Date().toISOString(), results };
writeFileSync(OUT, JSON.stringify(report, null, 2));

let failed = false;
for (const r of results) {
  const gate375 = r.width === 375;
  const marketOk = r.marketClipped === 0;
  const noOverflow = !r.horizontalOverflow;
  const rowsOk = r.rows.every((x) => x.retailerVisible && x.stockDotVisible && x.priceVisible);
  console.log(
    `${r.width} ${r.locale}: rows=${r.rowCount} marketLabels=${r.marketCount} clipped=${r.marketClipped} ` +
      `overflow=${r.horizontalOverflow} (${r.docScrollWidth}/${r.innerWidth}) rowsVisible=${rowsOk}` +
      (r.navError ? ` navError=${r.navError}` : ""),
  );
  for (const t of r.tokens.filter((x) => x.market)) {
    console.log(
      `  market "${t.text}" client=${t.clientWidth} scroll=${t.scrollWidth} lines=${t.lines} ` +
        `ws=${t.whiteSpace} overflowX=${t.overflowX} flex=${t.flex} clipped=${t.clipped}`,
    );
  }
  if (gate375 && (!marketOk || !noOverflow || !rowsOk)) failed = true;
}
console.log(`wrote ${OUT}`);
if (failed) {
  console.error("GATE FAILED — 375 success condition not met");
  process.exit(1);
}
