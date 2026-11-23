import { chromium } from "playwright-core";
const base = "http://localhost:3100";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${base}/_next/static/chunks/3dr73ety-r82g.css">
</head><body>
<div class="rc-offers-table">
<div class="rc-table-head" aria-hidden><span>Retailer</span><span>Price</span><span>Stock</span><span>Status</span><span>Checked</span><span></span></div>
<div class="rc-offer-row">
<div class="rc-offer-line line-a"><span class="rc-retailer-name"><bdi class="logo lat">Jarir</bdi></span><span class="rc-stock"><span class="dot"></span>In stock</span><span class="rc-status is-verified"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3 4.5 6v6c0 4.4 3.1 7.6 7.5 9 4.4-1.4 7.5-4.6 7.5-9V6L12 3Z"/></svg><span class="label">Verified</span></span></div>
<div class="rc-offer-line line-b">
<span class="rc-price-block"><span class="price-cur rc-price-sm tabular" style="font: var(--rc-text-price-sm); font-weight: 600; color: var(--rc-ink)"><bdi>SAR 5,199.00</bdi></span><span class="rc-price-meta"><span class="price-alt"><span class="price-alt-sep" aria-hidden>· </span><bdi>≈KD 424.24</bdi></span><span class="rc-checked">Checked just now</span></span></span>
<a class="btn-primary focusable min-h-9 shrink-0 px-3 rc-offer-cta" href="#">Go</a>
</div></div>
<div class="rc-offer-row">
<div class="rc-offer-line line-a"><span class="rc-retailer-name"><bdi class="logo lat">Xcite</bdi></span><span class="rc-stock"><span class="dot"></span>In stock</span><span class="rc-status is-verified"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3 4.5 6v6c0 4.4 3.1 7.6 7.5 9 4.4-1.4 7.5-4.6 7.5-9V6L12 3Z"/></svg><span class="label">Verified</span></span></div>
<div class="rc-offer-line line-b">
<span class="rc-price-block"><span class="price-cur rc-price-sm tabular" style="font: var(--rc-text-price-sm); font-weight: 600; color: var(--rc-ink)"><bdi>KD 314.90</bdi></span><span class="rc-price-meta"><span class="rc-checked">Checked just now</span></span></span>
<a class="btn-primary focusable min-h-9 shrink-0 px-3 rc-offer-cta" href="#">Go</a>
</div></div>
</div></body></html>`;
const browser = await chromium.launch({ executablePath: "/opt/ms-playwright/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
for (const w of [375, 1280]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.setContent(html, { waitUntil: "networkidle" });
  const data = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".rc-offers-table .rc-offer-row")).map((r) => {
      const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      return {
        rowH: Math.round(r.getBoundingClientRect().height),
        price: (r.querySelector(".rc-price-sm")?.textContent ?? "").trim(),
        alt: (r.querySelector(".price-alt")?.textContent ?? "").trim(),
        checked: (r.querySelector(".rc-checked")?.textContent ?? "").trim(),
        lineB: box(r.querySelector(".rc-offer-line.line-b")),
        priceBlock: box(r.querySelector(".rc-price-block")),
        priceMeta: box(r.querySelector(".rc-price-meta")),
        cta: box(r.querySelector(".rc-offer-cta")),
        overflow: r.scrollWidth > r.clientWidth,
      };
    });
  });
  console.log("===", w, JSON.stringify(data, null, 1));
  await ctx.close();
}
await browser.close();
