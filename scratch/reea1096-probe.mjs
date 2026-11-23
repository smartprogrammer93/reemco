/**
 * REEA-1096 — measure the Direction A Shelf surfaces (before/after).
 * Usage: node scratch/reea1096-probe.mjs <baseUrl> <outDir>
 * Measures: card geometry, offer rows (incl. foreign currency), status tokens,
 * variant chips, price colour, hero h1, AR coverage line + timestamps.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "/tmp/reea1096";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/opt/ms-playwright/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

const report = { base, at: new Date().toISOString(), results: {} };

function rgbToHex(s) {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return s;
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return "#" + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function open({ width, locale, dark }) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: dark ? "dark" : "light",
    locale: locale === "ar" ? "ar-KW" : "en-US",
  });
  await ctx.addCookies([{ name: "rc_locale", value: locale, url: base }]);
  return ctx;
}

function round(n) { return Math.round(n * 10) / 10; }

async function measureResults(page, label) {
  await page.goto(`${base}/results?q=${encodeURIComponent("iPhone 17 Pro")}`, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const data = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const cs = (el) => el ? getComputedStyle(el) : null;
    const cards = Array.from(document.querySelectorAll(".rc-card"));
    const cardData = cards.slice(0, 2).map((c) => ({
      h: Math.round(c.getBoundingClientRect().height),
      padding: cs(c).padding,
      gap: cs(c).gap,
      media: box(c.querySelector(".rc-card-media")),
      priceText: (c.querySelector(".rc-price-card")?.textContent ?? "").trim(),
      priceColor: cs(c.querySelector(".rc-price-card"))?.color,
      priceY: Math.round((c.querySelector(".rc-price-card")?.getBoundingClientRect().y ?? 0)),
      variants: Array.from(c.querySelectorAll(".rc-variant")).map((v) => ({
        text: (v.textContent ?? "").trim(),
        pressed: v.getAttribute("aria-pressed"),
        border: cs(v).borderTopWidth + " " + cs(v).borderTopColor,
        weight: cs(v).fontWeight,
        h: Math.round(v.getBoundingClientRect().height),
        hasCheck: !!v.querySelector(".check, svg"),
      })),
      rows: Array.from(c.querySelectorAll(".rc-offer-row")).map((r) => ({
        h: Math.round(r.getBoundingClientRect().height),
        price: (r.querySelector(".rc-price-sm")?.textContent ?? "").trim(),
        alt: (r.querySelector(".price-alt")?.textContent ?? "").trim(),
        checked: (r.querySelector(".rc-checked")?.textContent ?? "").trim(),
        status: (r.querySelector(".rc-status")?.textContent ?? "").trim(),
        statusW: Math.round((r.querySelector(".rc-status")?.getBoundingClientRect().width ?? 0)),
        statusPad: cs(r.querySelector(".rc-status"))?.paddingInline,
        statusIcon: cs(r.querySelector(".rc-status svg"))?.width,
        statusGap: cs(r.querySelector(".rc-status"))?.gap,
        overflow: r.scrollWidth > r.clientWidth,
      })),
      summary: (c.textContent ?? "").includes("retailers"),
      coupons: c.querySelectorAll(".coupon-line").length,
      leadCta: box(c.querySelector(".cta-lead")),
      pairs: !!c.querySelector('section[aria-label="Pairs with"]'),
    }));
    const doc = { h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth };
    const h1 = document.querySelector("h1");
    const h1cs = cs(h1);
    const statuses = {};
    for (const s of document.querySelectorAll(".rc-status")) {
      const text = (s.textContent ?? "").trim();
      const r = s.getBoundingClientRect();
      if (!statuses[text]) statuses[text] = { text, w: Math.round(r.width), h: Math.round(r.height), pad: cs(s)?.paddingInline, icon: cs(s.querySelector("svg"))?.width, gap: cs(s)?.gap };
    }
    return {
      doc,
      cards: cardData,
      h1: h1 ? { text: (h1.textContent ?? "").trim().slice(0, 80), fontSize: h1cs?.fontSize, lineHeight: h1cs?.lineHeight, fontFamily: h1cs?.fontFamily } : null,
      partial: (document.querySelector(".rc-partial")?.textContent ?? "").trim(),
      partialBdi: document.querySelectorAll(".rc-partial bdi.lat").length,
      partialHtml: (document.querySelector(".rc-partial")?.innerHTML ?? "").slice(0, 900),
      meta: (document.querySelector(".rc-results-meta")?.textContent ?? "").trim(),
      statuses,
      viewAll: Array.from(document.querySelectorAll(".rc-view-all")).map((a) => (a.textContent ?? "").trim()),
      cardMore: document.querySelectorAll(".rc-card-more").length,
      openOffers: Array.from(document.querySelectorAll(".rc-card")).map((c) => c.querySelectorAll(".rc-offer-row").length),
    };
  });
  for (const c of data.cards) {
    if (c.priceColor) c.priceColorHex = rgbToHex(c.priceColor);
  }
  report.results[label] = data;
  return data;
}

async function measureHome(page, label) {
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => {
    const h1 = document.querySelector(".rc-hero h1");
    const cs = h1 ? getComputedStyle(h1) : null;
    return {
      h1: h1 ? { text: (h1.textContent ?? "").trim().slice(0, 80), fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontFamily: cs.fontFamily, w: Math.round(h1.getBoundingClientRect().width) } : null,
      doc: { h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth },
    };
  });
  report.results[label] = data;
}

async function measureEmpty(page, label) {
  await page.goto(`${base}/results?q=${encodeURIComponent("zzzz-not-a-product-1096")}`, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const data = await page.evaluate(() => {
    const el = document.querySelector("[data-empty-state='true']");
    return {
      text: (el?.textContent ?? "").trim(),
      lines: el ? Array.from(el.querySelectorAll("h2, p")).map((n) => (n.textContent ?? "").trim()) : [],
      h: el ? Math.round(el.getBoundingClientRect().height) : null,
    };
  });
  report.results[label] = data;
}

async function measureProduct(page, label) {
  // open the first product card title link from results
  await page.goto(`${base}/results?q=${encodeURIComponent("iPhone 17 Pro")}`, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const href = await page.evaluate(() => document.querySelector(".rc-card-title a")?.getAttribute("href") ?? null);
  if (!href) { report.results[label] = { skipped: true }; return; }
  await page.goto(`${base}${href}`, { waitUntil: "networkidle", timeout: 120000 }).catch(() => {});
  await page.waitForSelector(".rc-offers-table .rc-offer-row, .rc-product-hero .rc-offer-row", { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const data = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const cs = (el) => el ? getComputedStyle(el) : null;
    const rows = Array.from(document.querySelectorAll(".rc-offers-table .rc-offer-row, .rc-product-hero .rc-offer-row")).map((r) => ({
      h: Math.round(r.getBoundingClientRect().height),
      w: Math.round(r.getBoundingClientRect().width),
      price: (r.querySelector(".rc-price-sm")?.textContent ?? "").trim(),
      alt: (r.querySelector(".price-alt")?.textContent ?? "").trim(),
      checked: (r.querySelector(".rc-checked")?.textContent ?? "").trim(),
      overflow: r.scrollWidth > r.clientWidth,
      priceCell: box(r.querySelector(".rc-price-block")),
    }));
    return {
      h1: box(document.querySelector("h1")),
      price: { text: (document.querySelector(".rc-product-hero .rc-price-card")?.textContent ?? "").trim(), font: cs(document.querySelector(".rc-product-hero .rc-price-card"))?.fontSize },
      rows,
      variants: Array.from(document.querySelectorAll(".rc-variant")).map((v) => ({ text: (v.textContent ?? "").trim(), pressed: v.getAttribute("aria-pressed"), hasCheck: !!v.querySelector(".check, svg") })),
    };
  });
  report.results[label] = data;
}

for (const [w, locale, dark] of [[375, "en", false], [1280, "en", false], [375, "ar", false], [1280, "ar", false], [375, "en", true]]) {
  const ctx = await open({ width: w, locale, dark });
  const page = await ctx.newPage();
  const tag = `${locale}-${w}${dark ? "-dark" : ""}`;
  await measureResults(page, `results-${tag}`);
  await measureHome(page, `home-${tag}`);
  await ctx.close();
}

{
  const ctx = await open({ width: 375, locale: "en", dark: false });
  const page = await ctx.newPage();
  await measureProduct(page, "product-en-375");
  await ctx.close();
}
{
  const ctx = await open({ width: 1280, locale: "en", dark: false });
  const page = await ctx.newPage();
  await measureProduct(page, "product-en-1280");
  await ctx.close();
}
{
  const ctx = await open({ width: 375, locale: "en", dark: false });
  const page = await ctx.newPage();
  await measureEmpty(page, "empty-en-375");
  await ctx.close();
}

await browser.close();
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
