/**
 * REEA-1094 — 375px offer-row containment probe for the Shelf result card.
 *
 * Measures the served /results page at 375x812 in EN and AR (rc_locale=ar) for
 * the query states that reproduced the smoke step-5 overflow before the fix:
 *   - documentElement.scrollWidth (the smoke's step-5 gate: must equal 375)
 *   - every offer row's rendered height per card (AC5 variance <= 8px)
 *   - offscreen CTAs with no scrollable ancestor (the defect's signature)
 *   - the widest rows' line-B child rects, so the anatomy decision is evidence
 *
 * Usage: BASE_URL=http://127.0.0.1:3100 node scripts/reea1094-probe.mjs
 * Prints one JSON block per locale/case and exits non-zero when a gate fails.
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const WIDTH = 375;
const HEIGHT = 812;
// Query states: the smoke fixture plus the two foreign-currency states that
// overflowed pre-fix (EGP 4,330.00 and EGP 65,010.00 rows).
const CASES = [
  { q: "sony", c: null },      // the smoke's step-5 fixture
  { q: "sony", c: "SA" },      // every row foreign-led (SAR + ≈KD alt)
  { q: "jarir", c: null },     // multi-row foreign cards
  { q: "sony", c: "EG" },      // the reported EGP rows (best effort: Amazon.eg)
];

// Same container bootstrap scripts/smoke-check.mjs uses.
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
const keeper = await browser.newPage();
await keeper.goto("about:blank");

async function measure(locale, testCase) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    locale: locale === "ar" ? "ar-KW" : "en-KW",
    extraHTTPHeaders: { "Accept-Language": locale },
  });
  if (locale === "ar") {
    await context.addCookies([{ name: "rc_locale", value: "ar", url: BASE }]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const url = `${BASE}/results?q=${encodeURIComponent(testCase.q)}${testCase.c ? `&c=${testCase.c}` : ""}`;
  await page.goto(url, { waitUntil: "load" });
  try {
    await page.waitForSelector("li.offer-row", { timeout: 30000 });
  } catch {
    await context.close();
    return { url, empty: true };
  }
  await page.waitForTimeout(1000); // let staged boundaries settle
  const data = await page.evaluate(() => {
    const scrollableAncestor = (el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (/(auto|scroll)/.test(s.overflowX)) return n.className || n.tagName;
      }
      return null;
    };
    const cards = [...document.querySelectorAll("article.rc-card")];
    const rows = [...document.querySelectorAll("li.offer-row")];
    const perCard = cards.map((card) => {
      const cardRows = [...card.querySelectorAll("li.offer-row")];
      return {
        rows: cardRows.length,
        heights: cardRows.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10),
      };
    });
    const offscreen = rows
      .flatMap((r) => [...r.querySelectorAll(".rc-offer-cta")])
      .map((a) => {
        const rect = a.getBoundingClientRect();
        return {
          text: (a.textContent || "").trim(),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          scrollAncestor: scrollableAncestor(a),
        };
      })
      .filter((x) => x.right > window.innerWidth + 0.5 || x.left < -0.5);
    // Widest line-B: dump the children's boxes for the anatomy decision.
    const widest = rows
      .map((r) => {
        const line = r.querySelector(".rc-offer-line.line-b");
        if (!line) return null;
        const lr = line.getBoundingClientRect();
        const kids = [...line.children].map((k) => {
          const kr = k.getBoundingClientRect();
          return {
            cls: (k.className || "").toString().slice(0, 40),
            w: Math.round(kr.width * 10) / 10,
            text: (k.textContent || "").trim().slice(0, 40),
          };
        });
        const contentW = kids.reduce((n, k) => n + k.w, 0) + Math.max(0, kids.length - 1) * 8;
        return {
          merchant: (r.querySelector(".logo")?.textContent || "").trim(),
          rowH: Math.round(r.getBoundingClientRect().height * 10) / 10,
          lineW: Math.round(lr.width * 10) / 10,
          lineH: Math.round(lr.height * 10) / 10,
          contentW: Math.round(contentW * 10) / 10,
          kids,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.contentW - a.contentW)
      .slice(0, 4);
    const foreignRows = rows.filter((r) => r.querySelector(".price-alt")).length;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      rowCount: rows.length,
      cardCount: cards.length,
      foreignRows,
      perCard,
      offscreen,
      widest,
    };
  });
  // Stress: the longest served collection stamp ("Checked 59 minutes ago" /
  // "حُدِّث قبل 59 دقيقة") can appear on a warm-cache row; swap it in and make
  // sure the anatomy still contains the row.
  const stress = await page.evaluate((loc) => {
    const stamp = loc === "ar" ? "حُدِّث قبل 59 دقيقة" : "Checked 59 minutes ago";
    for (const c of document.querySelectorAll("li.offer-row .rc-checked")) c.textContent = stamp;
    const offscreen = [...document.querySelectorAll("li.offer-row .rc-offer-cta")]
      .map((a) => {
        const r = a.getBoundingClientRect();
        return { text: (a.textContent || "").trim(), right: Math.round(r.right * 10) / 10, left: Math.round(r.left * 10) / 10 };
      })
      .filter((x) => x.right > window.innerWidth + 0.5 || x.left < -0.5);
    return { stamp, scrollWidth: document.documentElement.scrollWidth, offscreen };
  }, locale);
  await context.close();
  return { url, ...data, stress };
}

let failed = false;
for (const locale of ["en", "ar"]) {
  for (const testCase of CASES) {
    const m = await measure(locale, testCase);
    const tag = `${locale} ${testCase.q}${testCase.c ? `&c=${testCase.c}` : ""}`;
    if (m.empty) {
      console.log(`[${tag}] no offer rows (live data empty this run) — skipped`);
      continue;
    }
    const variances = m.perCard.filter((c) => c.rows > 1).map((c) => Math.max(...c.heights) - Math.min(...c.heights));
    const worstVariance = variances.length ? Math.round(Math.max(...variances) * 10) / 10 : 0;
    const overflow = m.scrollWidth > WIDTH;
    const stressOverflow = m.stress.scrollWidth > WIDTH;
    const gate =
      overflow || stressOverflow || m.offscreen.length > 0 || m.stress.offscreen.length > 0 || worstVariance > 8;
    if (gate) failed = true;
    console.log(
      `[${tag}] scrollWidth=${m.scrollWidth} (viewport ${WIDTH}) rows=${m.rowCount} cards=${m.cardCount} ` +
        `foreignRows=${m.foreignRows} worstCardRowHeightVariance=${worstVariance}px ` +
        `offscreenCTAs=${m.offscreen.length} longStampScrollWidth=${m.stress.scrollWidth} ` +
        `${gate ? "FAIL" : "PASS"}`,
    );
    console.log(JSON.stringify({ locale, case: tag, ...m }));
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
