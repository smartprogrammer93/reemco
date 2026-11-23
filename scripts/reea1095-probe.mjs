/**
 * REEA-1095 — re-check the two Direction A residual defects on a deployed or
 * local build:
 *   AC10/AC11 — the product provenance note is humanised/localised in EN/AR
 *               (no raw "0s ago"/"1s ago", no English "s ago" in AR).
 *   AC12      — OS-dark selected filter chip, primary buttons and amber chips
 *               are >= 4.5:1 (the light build is measured as the control).
 *
 * Usage: node scripts/reea1095-probe.mjs <baseUrl> [outDir]
 * Exit code 1 when any measured pair or note fails.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:3210";
const out = process.argv[3] ?? "/tmp/reea1095-probe";
fs.mkdirSync(out, { recursive: true });

function lum(hex) {
  const c = hex.replace("#", "").match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(fg, bg) {
  const L1 = lum(fg), L2 = lum(bg);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}
function rgbToHex(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return s;
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return "#" + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const browser = await chromium.launch({
  executablePath: "/opt/ms-playwright/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

const report = { base, results: {}, notes: {}, failures: [] };

async function open(locale, width, scheme) {
  const ctx = await browser.newContext({
    viewport: { width, height: width === 375 ? 812 : 800 },
    colorScheme: scheme,
    locale: locale === "ar" ? "ar-KW" : "en-US",
  });
  await ctx.addCookies([{ name: "rc_locale", value: locale, url: base }]);
  return ctx;
}

async function scanResults(page, label) {
  const data = await page.evaluate(() => {
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: (el.textContent ?? "").trim().slice(0, 60),
        bg: cs.backgroundColor,
        fg: cs.color,
      };
    });
    return {
      selectedChips: pick('.rc-chip[aria-pressed="true"], .rc-chip.is-selected'),
      primaryButtons: pick(".btn-primary"),
      r2Buttons: pick(".r2-btn"),
      couponBadges: pick(".coupon-badge"),
      cachedChips: pick(".cached-chip"),
    };
  });
  const rows = [];
  for (const [group, items] of Object.entries(data)) {
    for (const row of items) {
      row.fgHex = rgbToHex(row.fg);
      row.bgHex = rgbToHex(row.bg);
      row.ratio = ratio(row.fgHex, row.bgHex);
      if (row.ratio < 4.5) {
        report.failures.push(`${label} ${group} "${row.text}" ${row.ratio}:1 (${row.fgHex} on ${row.bgHex})`);
      }
      rows.push({ group, ...row });
    }
  }
  report.results[label] = rows;
  return rows;
}

for (const locale of ["en", "ar"]) {
  for (const scheme of ["dark", "light"]) {
    for (const width of [375, 1280]) {
      const ctx = await open(locale, width, scheme);
      const page = await ctx.newPage();
      await page.goto(`${base}/results?q=iPhone%2017%20Pro`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector(".rc-card", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const label = `results-${locale}-${width}-${scheme}`;
      const rows = await scanResults(page, label);
      await page.screenshot({ path: `${out}/${label}.png`, fullPage: false });
      const worst = rows.reduce((m, r) => (r.ratio < m ? r.ratio : m), 99);
      console.log(`== ${label}: ${rows.length} measured, worst ${worst}:1`);
      await ctx.close();
    }
  }
}

for (const locale of ["en", "ar"]) {
  const ctx = await open(locale, 375, "dark");
  const page = await ctx.newPage();
  await page.goto(`${base}/product/apple-iphone-17-pro-6-3-256gb-silver`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  let note = null;
  for (let i = 0; i < 60; i += 1) {
    note = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll("p")).find((el) =>
        /Live results|نتائج مباشرة/.test(el.textContent ?? ""),
      );
      return p ? p.textContent.trim() : null;
    });
    if (note) break;
    await page.waitForTimeout(1000);
  }
  const label = `product-${locale}-375-dark`;
  report.notes[label] = note;
  if (!note) {
    report.failures.push(`${label}: no "Live results"/"نتائج مباشرة" note rendered`);
  } else {
    const rawSeconds = /\d+s ago/.test(note);
    const arEnglish = locale === "ar" && /s ago/.test(note);
    const expected = locale === "ar" ? /الآن|قبل/.test(note) : /just now|min ago|hr ago|day ago/.test(note);
    if (rawSeconds || arEnglish || !expected) {
      report.failures.push(`${label}: note "${note}" is not humanised/localised`);
    }
  }
  await page.screenshot({ path: `${out}/${label}.png`, fullPage: false });
  console.log(`== ${label}: ${JSON.stringify(note)}`);
  await ctx.close();
}

fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
await browser.close();

if (report.failures.length) {
  console.error(`\nFAIL (${report.failures.length}):`);
  for (const f of report.failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("\nPASS — all measured pairs >= 4.5:1; both notes humanised/localised.");
