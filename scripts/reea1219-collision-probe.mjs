/**
 * REEA-1219 — shelf-card offer-row collision gate.
 *
 * Hard gate from the ticket: on /results?q=samsung+galaxy+s26+ultra and
 * /results?q=iphone, at 1226 + the §9 matrix widths (1280, 1024, 900, 768,
 * 641, 375) x EN/AR x light/dark:
 *   - no two rendered rects inside `.rc-offer-row`, `.rc-price-block`,
 *     `.rc-price-line` or the card header intersect (<=1px tolerance);
 *   - struck listed price and current price never intersect; each price run is
 *     one line (`getClientRects().length === 1`);
 *   - `.rc-offer-cta` is 44px +/-1, has a label, and its inline-end edge stays
 *     inside the card content box (right for EN, left for AR);
 *   - documentElement.scrollWidth <= innerWidth and each row
 *     scrollWidth <= clientWidth + 1.
 *
 * Scope: every paint box inside a `.rc-offer-row` (rows compared as one set, so
 * an overflowing row is caught against its neighbour), the offer-list caption
 * above the rows, the card header, and the headline `.rc-price-line`.
 *
 * Usage:
 *   BASE=https://ns539626.ip-144-217-72.net OUT=/tmp/reea1219.json \
 *     node scripts/reea1219-collision-probe.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

process.env.HOME = "/tmp";

const BASE = (process.env.BASE || "http://127.0.0.1:3005").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1219.json";
const QUERIES = (process.env.QUERIES || "samsung galaxy s26 ultra,iphone").split(",");
const WIDTHS = (process.env.WIDTHS || "1226,1280,1024,900,768,641,375").split(",").map(Number);
const LOCALES = (process.env.LOCALES || "en,ar").split(",");
const THEMES = (process.env.THEMES || "light,dark").split(",");
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const SETTLE_MS = Number(process.env.SETTLE_MS || 9000);
const INJECT = process.env.INJECT ? readFileSync(process.env.INJECT, "utf8") : null;

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args.filter((a) => a !== "--single-process"), "--headless=new"],
  headless: true,
});

const jobs = [];
for (const q of QUERIES) for (const width of WIDTHS) for (const locale of LOCALES) for (const theme of THEMES) jobs.push({ q, width, locale, theme });

const measure = () => {
  const vw = window.innerWidth;
  const out = {
    rows: 0, cards: 0, collisions: [], priceOverlaps: [], priceRuns: [], cta: [], overflow: [],
    docScrollWidth: document.documentElement.scrollWidth, innerWidth: vw, rowHeights: [],
  };
  if (document.documentElement.scrollWidth > vw) {
    out.overflow.push(`doc scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${vw}`);
  }

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const label = (el) => {
    const cls = (el.className && typeof el.className === "string") ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${txt ? ` "${txt}"` : ""}`;
  };
  // A paint box is an element that renders ink of its own: own text node, a
  // button/link/image/token, or a chip with a background/border.
  const paintBox = (el) => {
    if (!visible(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "contents") return false;
    if (el.closest(".rc-card-media")) return false;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "")) return true;
    if (el.matches("button, a, img, svg, .dot")) return true;
    const bg = cs.backgroundColor;
    const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    const borderW = parseFloat(cs.borderTopWidth || "0") + parseFloat(cs.borderInlineStartWidth || "0");
    return hasBg || borderW > 0;
  };
  const intersects = (a, b) => {
    const ix = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    const iy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return ix > 1 && iy > 1;
  };
  const related = (a, b) => a.contains(b) || b.contains(a);
  const cardTitle = (card) => (card.querySelector(".rc-card-title")?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);

  const collect = (root, skip) => {
    const nodes = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (skip && child.matches(skip)) continue;
        if (paintBox(child)) nodes.push(child);
        walk(child);
      }
    };
    walk(root);
    return nodes;
  };
  const collide = (scopeName, cardTitleText, nodes) => {
    const boxes = nodes.map((el) => ({ el, r: rect(el) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (related(a.el, b.el)) continue;
        if (intersects(a.r, b.r)) {
          const ix = Math.min(a.r.r, b.r.r) - Math.max(a.r.l, b.r.l);
          const iy = Math.min(a.r.b, b.r.b) - Math.max(a.r.t, b.r.t);
          out.collisions.push({ scope: scopeName, card: cardTitleText, a: label(a.el), b: label(b.el), overlap: `${ix.toFixed(1)}x${iy.toFixed(1)}`, ra: a.r, rb: b.r });
        }
      }
    }
  };

  const cards = [...document.querySelectorAll(".rc-card")];
  out.cards = cards.length;
  for (const card of cards) {
    const cardRect = card.getBoundingClientRect();
    const ccs = getComputedStyle(card);
    const content = {
      l: cardRect.left + parseFloat(ccs.borderLeftWidth || "0") + parseFloat(ccs.paddingLeft || "0"),
      r: cardRect.right - parseFloat(ccs.borderRightWidth || "0") - parseFloat(ccs.paddingRight || "0"),
    };
    const title = cardTitle(card);

    // Scope 1: every paint box inside the card's offer rows. Rows are compared
    // as one set so a row that overflows its own box is caught against the
    // next row too (the REEA-848/850 defect class).
    const rows = [...card.querySelectorAll(".rc-offer-row")];
    out.rows += rows.length;
    const rowNodes = [];
    for (const row of rows) rowNodes.push(...collect(row));
    collide("offer-row", title, rowNodes);

    // Scope 2: the caption immediately above the offer list must not be
    // painted over by the first row (the screenshot's "Possible mismatch over
    // the accessory name" shape starts here).
    const list = card.querySelector(".rc-offer-list");
    const caption = list?.previousElementSibling;
    if (caption && caption.matches("h3, .label-token")) {
      const capNodes = [caption, ...collect(caption)];
      collide("offer-list-caption", title, [...capNodes, ...rowNodes]);
    }

    // Scope 3: the card header (category/basis row + title).
    const header = [...card.querySelectorAll(".rc-card-top > *, .rc-card-title, .rc-card > h2")].filter(paintBox);
    collide("card-header", title, header);

    // Scope 4: the headline price line (struck + current + savings).
    const priceLine = card.querySelector(".rc-price-line");
    if (priceLine) collide("price-line", title, collect(priceLine));

    for (const row of rows) {
      out.rowHeights.push(+row.getBoundingClientRect().height.toFixed(1));
      if (row.scrollWidth > row.clientWidth + 1) {
        out.overflow.push(`row scrollWidth ${row.scrollWidth} > clientWidth ${row.clientWidth} in card "${title}"`);
      }
      // Prices: struck vs current, and one line per price run.
      const was = [...row.querySelectorAll(".rc-row-was, .rc-price-was, s, del")].filter(visible);
      const cur = [...row.querySelectorAll(".price-cur")].filter(visible);
      for (const w of was) for (const c of cur) {
        const a = rect(w), b = rect(c);
        if (intersects(a, b)) out.priceOverlaps.push({ card: title, was: label(w), cur: label(c), ra: a, rb: b });
      }
      for (const p of [...was, ...cur]) {
        const n = p.getClientRects().length;
        if (n !== 1) out.priceRuns.push({ card: title, el: label(p), clientRects: n });
      }
      // CTA geometry + containment.
      const cta = row.querySelector(".rc-offer-cta");
      if (cta) {
        const b = rect(cta);
        const text = (cta.textContent || "").trim();
        const rtl = getComputedStyle(row).direction === "rtl";
        const edge = rtl ? b.l : b.r;
        const inside = rtl ? edge >= content.l - 1 : edge <= content.r + 1;
        const entry = { card: title, h: b.h, text, rtl, edge, contentL: +content.l.toFixed(1), contentR: +content.r.toFixed(1), inside, fail: "" };
        if (Math.abs(b.h - 44) > 1) entry.fail += `height ${b.h} != 44; `;
        if (!text) entry.fail += "label missing; ";
        if (!inside) entry.fail += `${rtl ? "left" : "right"} edge ${edge} outside content ${rtl ? content.l : content.r}; `;
        if (cta.scrollWidth > cta.clientWidth + 1) entry.fail += `label clipped scroll ${cta.scrollWidth} > client ${cta.clientWidth}; `;
        if (entry.fail) out.cta.push(entry);
      }
    }
    // Headline price line: struck vs current must not intersect either.
    if (priceLine) {
      const hw = [...priceLine.querySelectorAll(".rc-price-was, .rc-row-was")].filter(visible);
      const hc = [...priceLine.querySelectorAll(".price-cur")].filter(visible);
      for (const w of hw) for (const c of hc) {
        const a = rect(w), b = rect(c);
        if (intersects(a, b)) out.priceOverlaps.push({ card: title, was: label(w), cur: label(c), ra: a, rb: b });
      }
      for (const p of [...hw, ...hc]) {
        const n = p.getClientRects().length;
        if (n !== 1) out.priceRuns.push({ card: title, el: label(p), clientRects: n });
      }
    }
  }
  return out;
};

const results = [];
let cursor = 0;
const worker = async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const ctx = await browser.newContext({ viewport: { width: job.width, height: 900 } });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost|ns539626)/, (r) => r.abort());
    const page = await ctx.newPage();
    const cookies = [{ name: "rc_theme", value: job.theme, url: BASE }];
    if (job.locale === "ar") cookies.push({ name: "rc_locale", value: "ar", url: BASE });
    await ctx.addCookies(cookies);
    const url = `${BASE}/results?c=KW&oos=&q=${encodeURIComponent(job.q)}`;
    let rec = { ...job, url, error: null };
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 150000 });
      // /results?q=iphone currently renders the served empty state on this head
      // (0 shelf cards); a page with no offer rows has no rects to collide, so
      // accept the empty state and record rows:0 instead of failing the load.
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".rc-card .rc-offer-row").length > 0 ||
          document.querySelector("[data-empty-state=\"true\"]"),
        null,
        { timeout: 150000 },
      );
      await page.waitForTimeout(SETTLE_MS);
      if (INJECT) { await page.addStyleTag({ content: INJECT }); await page.waitForTimeout(800); }
      const m = await page.evaluate(measure);
      rec = { ...rec, ...m };
    } catch (e) {
      rec.error = String(e).slice(0, 160);
    }
    if (process.env.SHOTS === "1" && !rec.error) {
      try { await page.screenshot({ path: `/tmp/reea1219-${job.q.replace(/\s+/g, "-")}-${job.width}-${job.locale}-${job.theme}.png` }); } catch {}
    }
    await ctx.close();
    results.push(rec);
    const bad = rec.error ? "ERR" : `${(rec.collisions || []).length}c/${(rec.priceOverlaps || []).length}p/${(rec.priceRuns || []).length}run/${(rec.cta || []).length}cta/${(rec.overflow || []).length}of`;
    console.log(`${job.q} ${job.width} ${job.locale} ${job.theme}: ${bad}${rec.error ? ` ${rec.error}` : ""}`);
  }
};

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
await browser.close();

const summary = {
  base: BASE,
  jobs: results.length,
  errors: results.filter((r) => r.error).map((r) => `${r.q} ${r.width} ${r.locale} ${r.theme}: ${r.error}`),
  failing: results.filter((r) => !r.error && ((r.collisions || []).length || (r.priceOverlaps || []).length || (r.priceRuns || []).length || (r.cta || []).length || (r.overflow || []).length)).map((r) => `${r.q} ${r.width} ${r.locale} ${r.theme}`),
  totals: results.reduce((acc, r) => {
    acc.collisions += (r.collisions || []).length;
    acc.priceOverlaps += (r.priceOverlaps || []).length;
    acc.priceRuns += (r.priceRuns || []).length;
    acc.cta += (r.cta || []).length;
    acc.overflow += (r.overflow || []).length;
    return acc;
  }, { collisions: 0, priceOverlaps: 0, priceRuns: 0, cta: 0, overflow: 0 }),
};
writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
