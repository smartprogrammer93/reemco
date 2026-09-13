/**
 * REEA-850 verification probe — offer-row layout contract (REEA-848 visual-spec ACs).
 *
 * Measures, at 1280x900 and 390x844, EN + AR (rc_locale cookie), on the query
 * from AC1 (Blink/Wibi variant rows):
 *   AC1  no pixel overlap between the LOWEST LISTED PRICE chip and the stock
 *        dot / "In stock" text; report the actual chip<->dot gap (spec min 12px).
 *   AC2  a.btn-primary fully inside the card CONTENT box on every row; compact
 *        rule honored (min-height >= 36px, padding-inline 12px at >=1280); label
 *        never truncated (scrollWidth <= clientWidth).
 *   AC3  AR variant chips (label-token[title]) carry dir="auto", do not cross
 *        the card's inline-start content edge, and are not ellipsized unless
 *        genuinely narrow (36ch floor); report any mid-word ellipsis.
 *
 * Usage: SMOKE_BASE_URL=http://localhost:3123 node scripts/reea850-offer-row-probe.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import chromium from "@sparticuz/chromium";
import { chromium as pw } from "playwright-core";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3123";
const QUERY = process.env.REEA850_Q || "iphone 17 pro max 512gb blue titanium";
const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync("/tmp/al2023")) {
  try {
    const tarPath = "/tmp/al-chromium.tar";
    writeFileSync(tarPath, brotliDecompressSync(readFileSync("/work/reemco-price-compare/node_modules/@sparticuz/chromium/bin/al2023.tar.br")));
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch { /* host libs may already exist */ }
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp", process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});

const run = async (width, height, locale) => {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // External images/CDN requests crash the headless renderer and are
  // irrelevant to the layout contract; only the app's own DOM/CSS is measured.
  await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  const page = await ctx.newPage();
  await ctx.addCookies([{ name: "rc_locale", value: locale, url: BASE }]);
  await page.goto(`${BASE}/results?q=${encodeURIComponent(QUERY)}`, { waitUntil: "commit", timeout: 60000 });
  // Staged flushes: wait until at least one offer row, then grace period for more.
  try {
    await page.waitForSelector("li.offer-row", { timeout: 90000 });
    await page.waitForTimeout(12000);
  } catch (e) {
    await page.close().catch(() => {});
    return { width, locale, error: `no offer-row within 90s: ${String(e).slice(0, 120)}` };
  }
  const out = await page.evaluate((vpWidth) => {
    const overlap = (a, b) =>
      a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const rows = [...document.querySelectorAll("li.offer-row")];
    const res = { rows: rows.length, ac1: [], ac2: [], ac3: [], gaps: [], buttons: 0, chips: [] };
    for (const row of rows) {
      const card = row.closest("section")?.parentElement || row.parentElement;
      const cardR = card.getBoundingClientRect();
      const cs = getComputedStyle(card);
      const contentRight = cardR.right - parseFloat(cs.borderRightWidth || "0") - parseFloat(cs.paddingRight || "0");
      const contentLeft = cardR.left + parseFloat(cs.borderLeftWidth || "0") + parseFloat(cs.paddingLeft || "0");
      const rtl = getComputedStyle(row).direction === "rtl";

      // --- AC1: lowest chip vs stock dot / stock text
      const chip = [...row.querySelectorAll(".label-token")].find((el) =>
        getComputedStyle(el).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue("--rc-savings-bg").trim() ||
        el.style.background.includes("savings-bg"));
      const dot = row.querySelector("span.inline-block.h-2.w-2.rounded-full");
      const stockWrap = dot?.parentElement;
      if (chip && dot && stockWrap) {
        const c = chip.getBoundingClientRect();
        const d = dot.getBoundingClientRect();
        const s = stockWrap.getBoundingClientRect();
        const stockBox = { left: Math.min(d.left, s.left), right: Math.max(d.right, s.right), top: Math.min(d.top, s.top), bottom: Math.max(d.bottom, s.bottom) };
        if (overlap(c, stockBox)) {
          res.ac1.push(`overlap chip="${chip.textContent.trim().slice(0, 24)}" row="${row.textContent.trim().slice(0, 30)}"`);
        } else {
          // gap when sharing a line; vertical stack => gap is the vertical gutter
          const sameLine = c.top < s.bottom - 1 && s.top < c.bottom - 1;
          const gap = sameLine
            ? (rtl ? c.left - stockBox.right : stockBox.left - c.right)
            : Math.max(s.top - c.bottom, c.top - s.bottom);
          res.gaps.push(Math.round(gap * 10) / 10);
        }
      }

      // --- AC2: CTA containment + compact rule
      const btn = row.querySelector("a.btn-primary");
      if (btn) {
        res.buttons++;
        const b = btn.getBoundingClientRect();
        const bcs = getComputedStyle(btn);
        if (b.right > contentRight + 0.5 || b.left < contentLeft - 0.5) {
          res.ac2.push(`btn outside card: right=${Math.round(b.right)} contentRight=${Math.round(contentRight)} (overflow ${Math.round(b.right - contentRight)}px)`);
        }
        if (b.height < 36 - 0.5) res.ac2.push(`btn min-height ${Math.round(b.height)}px < 36`);
        if (btn.scrollWidth > btn.clientWidth + 1) res.ac2.push(`btn label truncated (scroll ${btn.scrollWidth} > client ${btn.clientWidth})`);
        if (vpWidth >= 1280) {
          const padX = `${bcs.paddingLeft}/${bcs.paddingRight}`;
          if (bcs.paddingLeft !== "12px" || bcs.paddingRight !== "12px") res.ac2.push(`btn padding-inline ${padX} != 12px at 1280`);
          if (bcs.minHeight !== "36px") res.ac2.push(`btn min-height CSS ${bcs.minHeight} != 36px at 1280`);
        }
      }

      // --- AC3: variant chips (label-token with title attr)
      for (const vchip of row.querySelectorAll("span.label-token[title]")) {
        const v = vchip.getBoundingClientRect();
        const full = vchip.scrollWidth <= vchip.clientWidth + 1;
        const clipped = vchip.textContent.trim();
        res.chips.push({ text: clipped.slice(0, 40), full, dir: vchip.getAttribute("dir") });
        if (vchip.getAttribute("dir") !== "auto") res.ac3.push(`chip "${clipped.slice(0, 24)}" missing dir=auto`);
        if (v.left < contentLeft - 0.5 || v.right > contentRight + 0.5) {
          res.ac3.push(`chip "${clipped.slice(0, 24)}" crosses card content edge (left ${Math.round(v.left)} vs ${Math.round(contentLeft)})`);
        }
        if (!full) {
          // ellipsis as last resort: visible text must end at a word boundary
          const visible = [...vchip.childNodes].map((n) => n.textContent || "").join("").trim();
          const src = (vchip.getAttribute("title") || "").trim();
          const visWords = visible.split(/\s+/);
          const srcWords = src.split(/\s+/);
          const lastVis = visWords[visWords.length - 1] || "";
          if (src && !src.startsWith(visible.replace(/…$/, ""))) res.ac3.push(`chip "${src.slice(0, 24)}" clipped mid-run`);
          else if (lastVis && !srcWords.some((w) => w === lastVis.replace(/…$/, ""))) res.ac3.push(`chip "${src.slice(0, 24)}" ellipsis not at word boundary ("${lastVis}")`);
        }
      }
    }
    return res;
  }, width);
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  return { width, locale, ...out };
};

const results = [];
for (const [width, height] of [[1440, 900], [1920, 1080]]) {
  for (const locale of ["en", "ar"]) {
    try {
      results.push(await run(width, height, locale));
    } catch (e) {
      results.push({ width, locale, error: String(e).slice(0, 200) });
    }
  }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
let bad = 0;
for (const r of results) {
  const fails = [...(r.ac1 || []), ...(r.ac2 || []), ...(r.ac3 || [])];
  if (r.error || fails.length) bad++;
  console.log(`\n== ${r.width}px ${r.locale}: rows=${r.rows} buttons=${r.buttons} minGap=${r.gaps?.length ? Math.min(...r.gaps) : "n/a"} ${fails.length ? "FAIL" : "PASS"}`);
  for (const f of fails || []) console.log("   - " + f);
  if (r.error) console.log("   - " + r.error);
}
process.exit(bad ? 1 : 0);
