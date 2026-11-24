/**
 * REEA-1159 local acceptance probe — the theme control on the REAL built app.
 *
 * Run against `next start` (not the dev server) so the measured tree is the one
 * the gate builds:  node scripts/reea1159-theme-probe.mjs http://127.0.0.1:3005
 *
 * Proves, per viewport/locale: the control is visible with a >=44px box, one
 * click flips <html data-theme> and the painted canvas, the choice survives a
 * reload, and an explicit light choice beats a dark OS (emulated). Prints JSON
 * rows; exits non-zero on the first failed assertion.
 */
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = process.argv[2] ?? "http://127.0.0.1:3005";
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ check: name, ok: Boolean(ok), detail });
  if (!ok) failed++;
}

const exePath = await chromium.executablePath();
// @sparticuz ships --single-process; closing a browser context can take the
// whole browser down with it, so each scenario launches its own browser.
const launchArgs = chromium.args.filter((a) => a !== "--single-process");

async function withBrowser(fn) {
  const browser = await pw.launch({ executablePath: exePath, args: launchArgs, headless: true });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function box(page) {
  return page.locator("[data-theme-cookie]").boundingBox();
}

async function canvas(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function open(browser, { width, height, locale, colorScheme }) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale, colorScheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/about`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("[data-theme-cookie]", { timeout: 10000 });
  return page;
}

// --- EN desktop, OS light, no stored choice --------------------------------
await withBrowser(async (browser) => {
  const page = await open(browser, { width: 1280, height: 900, locale: "en-KW", colorScheme: "light" });
  const btn = page.locator("[data-theme-cookie]");
  const b = await box(page);
  check("EN/1280 control visible", await btn.isVisible(), null);
  check("EN/1280 44px box", b && b.width >= 44 && b.height >= 44, b);
  check("EN/1280 aria-label", (await btn.getAttribute("aria-label")) === "Dark mode", await btn.getAttribute("aria-label"));
  check("EN/1280 aria-pressed starts false", (await btn.getAttribute("aria-pressed")) === "false", null);
  check("EN/1280 no data-theme with no cookie", (await page.evaluate(() => document.documentElement.dataset.theme ?? null)) === null, null);
  const lightCanvas = await canvas(page);
  await btn.click();
  const darkCanvas = await canvas(page);
  check("EN/1280 click sets data-theme=dark", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", null);
  check("EN/1280 click flips canvas", lightCanvas !== darkCanvas, { lightCanvas, darkCanvas });
  check("EN/1280 click sets aria-pressed", (await btn.getAttribute("aria-pressed")) === "true", null);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-theme-cookie]");
  check("EN/1280 reload keeps dark", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", null);
  check("EN/1280 reload paints dark", (await canvas(page)) === darkCanvas, null);
  await page.locator("[data-theme-cookie]").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-theme-cookie]");
  check("EN/1280 explicit light survives reload", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light", null);
});

// --- EN 375, OS dark, no stored choice: OS still governs -------------------
await withBrowser(async (browser) => {
  const page = await open(browser, { width: 375, height: 800, locale: "en-KW", colorScheme: "dark" });
  const btn = page.locator("[data-theme-cookie]");
  const b = await box(page);
  check("EN/375 control visible", await btn.isVisible(), null);
  check("EN/375 44px box", b && b.width >= 44 && b.height >= 44, b);
  check("EN/375 no data-theme with no cookie", (await page.evaluate(() => document.documentElement.dataset.theme ?? null)) === null, null);
  check("EN/375 OS dark paints dark", (await canvas(page)) === "rgb(23, 19, 16)", await canvas(page));
  await btn.click();
  check("EN/375 click -> explicit light", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light", null);
  check("EN/375 explicit light beats dark OS", (await canvas(page)) === "rgb(248, 245, 239)", await canvas(page));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-theme-cookie]");
  check("EN/375 reload keeps explicit light", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light", null);
});

// --- AR 375 (RTL), stored dark --------------------------------------------
await withBrowser(async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, locale: "ar-KW", colorScheme: "light" });
  await ctx.addCookies([
    { name: "rc_locale", value: "ar", url: BASE },
    { name: "rc_theme", value: "dark", url: BASE },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/about`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("[data-theme-cookie]");
  const btn = page.locator("[data-theme-cookie]");
  const b = await box(page);
  check("AR/375 dir=rtl", (await page.evaluate(() => document.documentElement.dir)) === "rtl", null);
  check("AR/375 control visible", await btn.isVisible(), null);
  check("AR/375 44px box", b && b.width >= 44 && b.height >= 44, b);
  check("AR/375 Arabic aria-label", (await btn.getAttribute("aria-label")) === "الوضع الداكن", await btn.getAttribute("aria-label"));
  check("AR/375 stored dark is pressed", (await btn.getAttribute("aria-pressed")) === "true", null);
  check("AR/375 dark canvas from stored cookie", (await canvas(page)) === "rgb(23, 19, 16)", await canvas(page));
  check("AR/375 control inside viewport", b && b.x >= 0 && b.x + b.width <= 375, b);
  await btn.click();
  check("AR/375 click -> light", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light", null);
  check("AR/375 light canvas", (await canvas(page)) === "rgb(248, 245, 239)", await canvas(page));
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.check}${r.detail ? " :: " + JSON.stringify(r.detail) : ""}`);
console.log(`RESULT ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
