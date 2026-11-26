/**
 * REEA-1205 — responsive-spec rev 1 geometry probe.
 * Measures the hero offer row (PDP) and the shelf card offer row (/results) on
 * one fixed stamp and prints the §9 numbers as JSON. Read-only.
 *
 * Usage:
 *   BASE=http://127.0.0.1:3005 OUT=/tmp/reea1205.json node reea1205-probe.tmp.mjs
 */
import { writeFileSync } from "node:fs";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

process.env.HOME = "/tmp";

const BASE = (process.env.BASE || "http://127.0.0.1:3005").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1205.json";
const PDP_PATH = process.env.PDP || "/product/apple-iphone17-256gb?q=iphone";
const SHELF_PATH = process.env.SHELF || "/results?q=iphone";
const WIDTHS = (process.env.WIDTHS || "375,641,700,768,900,1024,1280").split(",").map(Number);
const LOCALES = (process.env.LOCALES || "en,ar").split(",");
const THEMES = (process.env.THEMES || "light,dark").split(",");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args.filter((a) => a !== "--single-process"), "--headless=new"],
  headless: true,
});

function cookieJar(locale, theme) {
  const jars = [{ name: "rc_theme", value: theme, url: BASE }];
  if (locale === "ar") jars.push({ name: "rc_locale", value: "ar", url: BASE });
  return jars;
}

const collect = (want) => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
      right: +r.right.toFixed(2), left: +r.left.toFixed(2),
    };
  };
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const rowInfo = (row) => {
    if (!row) return null;
    const style = cs(row);
    const priceCur = row.querySelector(".price-cur");
    const checked = row.querySelector(".rc-checked");
    const logo = row.querySelector(".rc-retailer-name .logo");
    const retailer = row.querySelector(".rc-retailer-name");
    const status = row.querySelector(".rc-status");
    const cta = row.querySelector(".rc-offer-cta");
    const stock = row.querySelector(".rc-stock");
    const alt = row.querySelector(".price-alt");
    const rr = rect(row);
    return {
      row: rr, rowClientWidth: row.clientWidth, rowScrollWidth: row.scrollWidth,
      display: style.display, gridTemplateColumns: style.gridTemplateColumns,
      gridTemplateRows: style.gridTemplateRows, alignItems: style.alignItems,
      columnGap: style.columnGap, rowGap: style.rowGap,
      paddingInlineStart: style.paddingInlineStart, paddingBlockStart: style.paddingBlockStart,
      price: rect(priceCur), priceText: priceCur ? priceCur.textContent.trim() : null,
      priceClientRects: priceCur ? priceCur.getClientRects().length : 0,
      priceWhiteSpace: priceCur ? cs(priceCur).whiteSpace : null,
      priceLineHeight: priceCur ? cs(priceCur).lineHeight : null,
      priceFontSize: priceCur ? cs(priceCur).fontSize : null,
      priceBdiDir: priceCur && priceCur.querySelector("bdi") ? priceCur.querySelector("bdi").getAttribute("dir") : null,
      checked: rect(checked), checkedText: checked ? checked.textContent.trim() : null,
      checkedWhiteSpace: checked ? cs(checked).whiteSpace : null,
      checkedInsideRow: checked && rr ? rect(checked).right <= rr.right + 1 && rect(checked).left >= rr.left - 1 : null,
      retailer: rect(retailer), logo: rect(logo), logoText: logo ? logo.textContent.trim() : null,
      logoDir: logo ? logo.getAttribute("dir") : null, logoClientRects: logo ? logo.getClientRects().length : 0,
      stock: rect(stock), stockText: stock ? stock.textContent.trim() : null,
      stockDisplay: stock ? cs(stock).display : null, stockFontSize: stock ? cs(stock).fontSize : null,
      status: rect(status), statusText: status ? status.textContent.trim() : null,
      cta: rect(cta), ctaText: cta ? cta.textContent.trim() : null,
      ctaInsideRow: cta && rr ? rect(cta).right <= rr.right + 1 && rect(cta).left >= rr.left - 1 : null,
      alt: rect(alt), altDisplay: alt ? cs(alt).display : null,
    };
  };
  const docEl = document.documentElement;
  const hero = document.querySelector(".rc-product-hero");
  const heroMedia = document.querySelector(".rc-product-media");
  const heroRows = document.querySelectorAll(".rc-product-hero .rc-offer-row");
  const cards = [...document.querySelectorAll(".rc-card")];
  const card = cards[0] || null;
  const cardRows = document.querySelectorAll(".rc-card .rc-offer-row");
  const shelf = document.querySelector(".rc-shelf");
  return {
    want, innerWidth: window.innerWidth, docScrollWidth: docEl.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth, htmlDir: docEl.getAttribute("dir"),
    lang: docEl.getAttribute("lang"), theme: docEl.getAttribute("data-theme"),
    hero: hero ? { display: cs(hero).display, gridTemplateColumns: cs(hero).gridTemplateColumns, rect: rect(hero) } : null,
    heroMedia: heroMedia ? { rect: rect(heroMedia), inlineSize: cs(heroMedia).inlineSize } : null,
    heroRowsCount: heroRows.length, heroRow: rowInfo(heroRows[0]),
    cardCount: cards.length,
    card: card ? { rect: rect(card), paddingInlineStart: cs(card).paddingInlineStart, paddingBlockStart: cs(card).paddingBlockStart } : null,
    cardRowsCount: cardRows.length, cardRow: rowInfo(cardRows[0]),
    cardRowHeights: [...cardRows].slice(0, 6).map((r) => +r.getBoundingClientRect().height.toFixed(2)),
    shelf: shelf ? { gridTemplateColumns: cs(shelf).gridTemplateColumns, columnGap: cs(shelf).columnGap, rect: rect(shelf) } : null,
    shelfCardWidths: cards.slice(0, 4).map((c) => +c.getBoundingClientRect().width.toFixed(2)),
  };
};

const results = [];
for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      const entry = { width, locale, theme };
      const ctx = await browser.newContext({
        viewport: { width, height: 1100 },
        locale: locale === "ar" ? "ar-KW" : "en-KW",
        colorScheme: theme === "dark" ? "dark" : "light",
      });
      await ctx.addCookies(cookieJar(locale, theme));
      try {
        const heroPage = await ctx.newPage();
        await heroPage.goto(`${BASE}${PDP_PATH}`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await heroPage.waitForSelector(".rc-product-hero .rc-offer-row", { timeout: 90000 });
        await heroPage.waitForTimeout(500);
        entry.heroData = await heroPage.evaluate(collect, "hero");
        await heroPage.close();

        const shelfPage = await ctx.newPage();
        await shelfPage.goto(`${BASE}${SHELF_PATH}`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await shelfPage.waitForSelector(".rc-card .rc-offer-row", { timeout: 90000 });
        await shelfPage.waitForTimeout(500);
        entry.shelfData = await shelfPage.evaluate(collect, "shelf");
        await shelfPage.close();
        entry.ok = true;
      } catch (err) {
        entry.ok = false;
        entry.error = String(err).slice(0, 200);
      }
      await ctx.close();
      results.push(entry);
      const h = entry.heroData?.heroRow;
      const c = entry.shelfData?.cardRow;
      console.log(
        `${width} ${locale} ${theme} ${entry.ok ? "ok" : "FAIL"} ` +
          (entry.ok
            ? `heroRowW=${h?.row?.w} heroRowH=${h?.row?.h} logo=${h?.logo?.w} priceH=${h?.price?.h} ctaH=${h?.cta?.h} | cardW=${entry.shelfData?.card?.rect?.w} cardRowH=${c?.row?.h} cardRowW=${c?.row?.w} cardLogo=${c?.logo?.w} docScroll=${entry.shelfData?.docScrollWidth}/${entry.shelfData?.innerWidth}`
            : entry.error || ""),
      );
    }
  }
}

await browser.close();
writeFileSync(OUT, JSON.stringify({ base: BASE, pdp: PDP_PATH, shelf: SHELF_PATH, results }, null, 2));
console.log("wrote", OUT);
