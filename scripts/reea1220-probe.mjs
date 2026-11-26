import { writeFileSync } from "node:fs";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

process.env.HOME = "/tmp";
const BASE = (process.env.BASE || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1220.json";
const PDP_PATH = process.env.PDP || "/product/apple-iphone17-256gb?q=iphone";
const WIDTHS = (process.env.WIDTHS || "641,700,768").split(",").map(Number);
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

const collect = () => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2), left: +b.left.toFixed(2), right: +b.right.toFixed(2), top: +b.top.toFixed(2), bottom: +b.bottom.toFixed(2) };
  };
  const overlapX = (a, b) => (a && b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) : null);
  const row = document.querySelector(".rc-product-hero .rc-offer-row");
  const status = row?.querySelector(".rc-status");
  const label = status?.querySelector(".label");
  const checked = row?.querySelector(".rc-checked");
  const cta = row?.querySelector(".rc-offer-cta");
  const icon = status?.querySelector("svg");
  const doc = document.documentElement;
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const lcs = cs(label);
  return {
    innerWidth: window.innerWidth, docScrollWidth: doc.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
    row: r(row), rowDisplay: cs(row)?.display, gridTemplateColumns: cs(row)?.gridTemplateColumns,
    status: r(status), statusLabel: label ? label.textContent.trim() : null,
    icon: r(icon), iconInsideStatus: (() => { const s = r(status), i = r(icon); return s && i ? i.left >= s.left - 1 && i.right <= s.right + 1 && i.top >= s.top - 1 && i.bottom <= s.bottom + 1 : null; })(),
    label: r(label), labelDisplay: lcs?.display, labelPosition: lcs?.position, labelOverflow: lcs?.overflow, labelClipPath: lcs?.clipPath,
    checked: r(checked), checkedText: checked?.textContent.trim(),
    labelCheckedOverlapX: overlapX(r(label), r(checked)),
    statusCheckedOverlapX: overlapX(r(status), r(checked)),
    labelInsideStatus: (() => { const s = r(status), l = r(label); return s && l ? l.left >= s.left - 1 && l.right <= s.right + 1 && l.top >= s.top - 1 && l.bottom <= s.bottom + 1 : null; })(),
    cta: r(cta), ctaText: cta?.textContent.trim(),
    statusAria: status?.getAttribute("aria-label"), statusTitle: status?.getAttribute("title"), statusDataTip: status?.getAttribute("data-tip"),
    statusClass: status?.className,
    statusPaddingInline: cs(status)?.paddingInlineStart,
    headSpans: [...document.querySelectorAll(".rc-product-hero .rc-table-head > span")].map((el) => ({ text: el.textContent.trim(), rect: r(el), display: cs(el)?.display })),
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
        const page = await ctx.newPage();
        await page.goto(`${BASE}${PDP_PATH}`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForSelector(".rc-product-hero .rc-offer-row", { timeout: 90000 });
        await page.waitForTimeout(500);
        entry.data = await page.evaluate(collect);
        await page.screenshot({ path: `/tmp/reea1220-${width}-${locale}-${theme}.png`, fullPage: false });
        await page.close();
        entry.ok = true;
      } catch (err) {
        entry.ok = false;
        entry.error = String(err).slice(0, 200);
      }
      await ctx.close();
      results.push(entry);
      const d = entry.data;
      console.log(`${width} ${locale} ${theme} ${entry.ok ? "ok" : "FAIL"} row=${d?.row?.w}x${d?.row?.h} status=${d?.status?.w}x${d?.status?.h} label=${d?.label?.w}x${d?.label?.h} labelChecked=${d?.labelCheckedOverlapX} inside=${d?.labelInsideStatus} doc=${d?.docScrollWidth}/${d?.innerWidth}`);
    }
  }
}
await browser.close();
writeFileSync(OUT, JSON.stringify({ base: BASE, pdp: PDP_PATH, results }, null, 2));
console.log("wrote", OUT);
