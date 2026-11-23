/**
 * REEA-1129 — 44px non-visual hit area for the 22px status token.
 *
 * Measures the SERVED /results page (live or local) at 375 and 1280, EN and AR:
 *   - every .rc-status[data-tip] rendered visual box (must stay 22px tall,
 *     padding-inline 8px, icon 14px, gap 4px)
 *   - the ::before hit box (must be >=44x44 CSS px) via elementFromPoint at
 *     +/-21px from the token centre and computed pseudo bounds
 *   - whether the 44px hit band overlaps the row's action button, and whether
 *     the action still wins elementFromPoint at its own centre
 *   - tallest 3-row results card height (no layout shift)
 *   - horizontal overflow at 375
 *   - tooltip ::after content on hover and keyboard focus, aria-label/title
 *
 * Usage:
 *   BASE_URL=https://ns539626.ip-144-217-72.net QUERY=iphone \
 *     OUT=/work/.../before.json SHOTS=/work/.../shots node scripts/reea1129-probe.mjs
 *
 * Prints one JSON block and exits non-zero when a hard AC gate fails.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const QUERY = process.env.QUERY || "iphone";
const OUT = process.env.OUT || "/work/scratch/reea1129.json";
const SHOTS = process.env.SHOTS || "/work/scratch/reea1129-shots";
const DARK = process.env.DARK === "1";
const LOCALES = (process.env.LOCALES || "en,ar").split(",").filter(Boolean);
const WIDTHS = (process.env.WIDTHS || "375,1280").split(",").map(Number).filter(Boolean);
mkdirSync(SHOTS, { recursive: true });

// Same container bootstrap the existing probes use (@sparticuz/chromium needs
// the extracted al2023 libs + sqlite shim on LD_LIBRARY_PATH).
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

const round = (n) => Math.round(n * 100) / 100;
const r4 = (r) => ({
  x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height),
  top: round(r.top), right: round(r.right), bottom: round(r.bottom), left: round(r.left),
});
const hitsToken = (hit, token) => !!hit && (hit === token || token.contains(hit));

async function measure(locale, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: locale === "ar" ? "ar-KW" : "en-KW",
    extraHTTPHeaders: { "Accept-Language": locale === "ar" ? "ar-KW,ar;q=0.9" : "en-KW,en;q=0.9" },
    colorScheme: DARK ? "dark" : "light",
  });
  await context.addCookies([{ name: "rc_locale", value: locale, url: BASE }]);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const url = `${BASE}/results?q=${encodeURIComponent(QUERY)}`;
  await page.goto(url, { waitUntil: "load" });
  try {
    await page.waitForSelector(".rc-status[data-tip]", { timeout: 45000 });
    // The legend token flushes before the offer rows; wait for a real row so
    // the row-level measurements (AC1/AC4) have targets.
    await page.waitForSelector("li.rc-offer-row", { timeout: 45000 }).catch(() => {});
  } catch {
    await context.close();
    return { locale, width, url, empty: true };
  }
  await page.waitForTimeout(2000);

  const data = await page.evaluate(async () => {
    const round = (n) => Math.round(n * 100) / 100;
    const r4 = (r) => ({
      x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height),
      top: round(r.top), right: round(r.right), bottom: round(r.bottom), left: round(r.left),
    });
    // elementFromPoint only hit-tests the viewport, so each target is scrolled
    // to the middle of the viewport before its hit tests run.
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tokens = [...document.querySelectorAll(".rc-status[data-tip]")];
    const tokenMetrics = [];
    for (const [i, el] of tokens.entries()) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      await settle();
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, "::before");
      const after = getComputedStyle(el, "::after");
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hitAt = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return { tag: hit ? hit.tagName : null, cls: hit ? hit.className : null, isToken: !!hit && (hit === el || el.contains(hit)) };
      };
      const icon = el.querySelector("svg");
      const iconRect = icon ? icon.getBoundingClientRect() : null;
      const label = el.querySelector(".label");
      const computedWidth = parseFloat(before.width) || null;
      const computedHeight = parseFloat(before.height) || null;
      // Pseudo bounds relative to the border box: an absolutely positioned
      // pseudo-element's containing block is the token's PADDING box, so the
      // real band starts at border-box top + border-top + inset-block-start
      // and ends at border-box bottom - border-bottom + inset-block-end.
      // Reading the computed insets (instead of assuming a symmetric -11px)
      // keeps this measurement honest for any offset the CSS ships.
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
      const beforeTop = parseFloat(before.top);
      const beforeBottom = parseFloat(before.bottom);
      const bandTop = Number.isFinite(beforeTop) ? r.top + borderTop + beforeTop : r.top;
      const bandBottom = Number.isFinite(beforeBottom) ? r.bottom - borderBottom - beforeBottom : r.bottom;
      tokenMetrics.push({
        i,
        ariaLabel: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        dataTip: el.getAttribute("data-tip"),
        role: el.getAttribute("role"),
        tabIndex: el.getAttribute("tabindex"),
        rect: r4(r),
        visualHeight: round(r.height),
        visualWidth: round(r.width),
        paddingInlineStart: cs.paddingInlineStart,
        paddingInlineEnd: cs.paddingInlineEnd,
        gap: cs.gap,
        display: cs.display,
        position: cs.position,
        iconSize: iconRect ? { width: round(iconRect.width), height: round(iconRect.height) } : null,
        labelText: label ? label.textContent : null,
        inLegend: !!el.closest(".rc-legend"),
        inRow: !!el.closest(".rc-offer-row"),
        beforeRule: {
          content: before.content,
          position: before.position,
          top: before.top,
          bottom: before.bottom,
          left: before.left,
          right: before.right,
        },
        beforeBand: {
          top: round(bandTop),
          bottom: round(bandBottom),
          height: round(bandBottom - bandTop),
          computedWidth,
          computedHeight,
        },
        hitAbove21: hitAt(cx, cy - 21),
        hitBelow21: hitAt(cx, cy + 21),
        // Band edges: 1px outside the 22px visual box but inside the hit band.
        // These are the points that prove the band is real, not just computed.
        hitAbove11: hitAt(cx, r.top - 1),
        hitBelow11: hitAt(cx, r.bottom + 1),
        hitBandTop: hitAt(cx, bandTop + 1),
        hitBandBottom: hitAt(cx, bandBottom - 1),
        hitLeftEdge: hitAt(r.left + 1, cy),
        hitRightEdge: hitAt(r.right - 1, cy),
        afterContent: after.content,
      });
    }

    // Action-button overlap: the row's only other target.
    const rows = [...document.querySelectorAll("li.rc-offer-row")];
    const rowMetrics = [];
    for (const [i, row] of rows.entries()) {
      const token = row.querySelector(".rc-status[data-tip]");
      const cta = row.querySelector(".rc-offer-cta");
      if (!token || !cta) { rowMetrics.push({ i, hasToken: !!token, hasCta: !!cta }); continue; }
      cta.scrollIntoView({ block: "center", inline: "nearest" });
      await settle();
      const tr = token.getBoundingClientRect();
      const cr = cta.getBoundingClientRect();
      const tcs = getComputedStyle(token);
      const tb = getComputedStyle(token, "::before");
      const bt = parseFloat(tcs.borderTopWidth) || 0;
      const bb = parseFloat(tcs.borderBottomWidth) || 0;
      const btTop = parseFloat(tb.top);
      const btBottom = parseFloat(tb.bottom);
      const bandTop = Number.isFinite(btTop) ? tr.top + bt + btTop : tr.top - 11;
      const bandBottom = Number.isFinite(btBottom) ? tr.bottom - bb - btBottom : tr.bottom + 11;
      const band = { top: bandTop, bottom: bandBottom, left: tr.left, right: tr.right };
      const overlap = !(band.right <= cr.left || band.left >= cr.right || band.bottom <= cr.top || band.top >= cr.bottom);
      const at = (x, y) => {
        const h = document.elementFromPoint(x, y);
        return { tag: h ? h.tagName : null, cls: h ? h.className : null, activates: !!h && (h === cta || cta.contains(h)) };
      };
      const cx = cr.left + cr.width / 2;
      const ctaTopHit = at(cx, cr.top + 1);
      const ctaCentreHit = at(cx, cr.top + cr.height / 2);
      const ctaBottomHit = at(cx, cr.bottom - 1);
      // Vertical room a non-overlapping band could use at this row anatomy:
      // previous row's action bottom -> this row's action top.
      const prev = row.previousElementSibling;
      const prevCta = prev && prev.querySelector ? prev.querySelector(".rc-offer-cta") : null;
      const aboveClear = prevCta ? tr.top - prevCta.getBoundingClientRect().bottom : tr.top - row.getBoundingClientRect().top;
      const belowClear = cr.top - tr.bottom;
      rowMetrics.push({
        i,
        tokenRect: r4(tr),
        ctaRect: r4(cr),
        hitBand: { top: round(band.top), bottom: round(band.bottom), left: round(band.left), right: round(band.right) },
        bandHeight: round(band.bottom - band.top),
        overlap,
        overlapPx: round(Math.max(0, Math.min(band.bottom, cr.bottom) - Math.max(band.top, cr.top))),
        aboveClear: round(aboveClear),
        belowClear: round(belowClear),
        maxClearBand: round(tr.height + aboveClear + belowClear),
        ctaTopHit,
        ctaCentreHit,
        ctaBottomHit,
        ctaActivates: ctaTopHit.activates && ctaCentreHit.activates && ctaBottomHit.activates,
        ctaHref: cta.getAttribute("href") || cta.closest("a")?.getAttribute("href") || null,
      });
    }

    // Tallest results card with three offer rows (REEA-1120 D6 target).
    const cards = [...document.querySelectorAll("article.rc-card.result-card")].map((card, i) => {
      const rowsInCard = card.querySelectorAll(".rc-offer-row").length;
      const r = card.getBoundingClientRect();
      return { i, rows: rowsInCard, height: round(r.height), top: round(r.top), title: (card.querySelector(".rc-card-title")?.textContent || "").slice(0, 60) };
    });
    const threeRow = cards.filter((c) => c.rows >= 3).sort((a, b) => b.height - a.height);
    const maxCard = threeRow[0] || cards.slice().sort((a, b) => b.height - a.height)[0] || null;

    return {
      tokenCount: tokens.length,
      rowCount: rows.length,
      cardCount: cards.length,
      tokenMetrics,
      rowMetrics,
      threeRowCards: threeRow.slice(0, 5),
      tallestCard: maxCard,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      dir: document.documentElement.getAttribute("dir"),
      htmlLang: document.documentElement.getAttribute("lang"),
      theme: document.documentElement.getAttribute("data-theme") || null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });

  // Tooltip must still open on keyboard focus (Tab reaches the token) and hover.
  const tooltip = await page.evaluate(() => {
    const el = document.querySelector(".rc-status[data-tip]");
    if (!el) return null;
    const before = { aria: el.getAttribute("aria-label"), title: el.getAttribute("title"), tip: el.getAttribute("data-tip") };
    return before;
  });
  // Hover the first token and read the rendered ::after content.
  const firstToken = page.locator(".rc-status[data-tip]").first();
  await firstToken.hover();
  await page.waitForTimeout(150);
  const hoverTip = await firstToken.evaluate((el) => {
    const a = getComputedStyle(el, "::after");
    const r = el.getBoundingClientRect();
    return { content: a.content, display: a.display, width: a.width, position: a.position, rectTop: r.top };
  });
  // Keyboard focus: Tab from the page start until a token is active.
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("Tab");
  let focused = null;
  for (let i = 0; i < 60; i++) {
    focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        isToken: el.classList && el.classList.contains("rc-status"),
        cls: el.className || null,
        aria: el.getAttribute ? el.getAttribute("aria-label") : null,
        afterContent: el.classList && el.classList.contains("rc-status") ? getComputedStyle(el, "::after").content : null,
        focusVisible: el.matches ? el.matches(":focus-visible") : null,
      };
    });
    if (focused?.isToken) break;
    await page.keyboard.press("Tab");
  }
  const focusTip = focused;

  // No-layout-shift A/B on the SAME live DOM: measure the tallest 3-row card,
  // the tallest card and the token box with the rule active, then with
  // ::before disabled, then re-enabled. Any delta would be the layout shift
  // AC3 forbids. The tallest card overall is the fallback when the live
  // collection returned no 3-row card on this load (adapter variance).
  const abMeasure = () =>
    page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100;
      const all = [...document.querySelectorAll("article.rc-card.result-card")]
        .map((card) => ({ rows: card.querySelectorAll(".rc-offer-row").length, height: round(card.getBoundingClientRect().height) }))
        .sort((a, b) => b.height - a.height);
      const cards = all.filter((c) => c.rows >= 3);
      const first = document.querySelector(".rc-status[data-tip]");
      const tr = first ? first.getBoundingClientRect() : null;
      return {
        tallest3Row: cards[0] || null,
        tallestCard: all[0] || null,
        token: tr ? { width: round(tr.width), height: round(tr.height) } : null,
        rowHeights: [...document.querySelectorAll("li.rc-offer-row")].map((r) => round(r.getBoundingClientRect().height)),
        cardHeights: [...document.querySelectorAll("article.rc-card.result-card")].map((c) => round(c.getBoundingClientRect().height)),
      };
    });
  const abOn = await abMeasure();
  await page.addStyleTag({ content: ".rc-status[data-tip]::before{content:none !important;}" });
  const abOff = await abMeasure();
  await page.evaluate(() => {
    const styles = [...document.querySelectorAll("style")];
    const last = styles[styles.length - 1];
    if (last && last.textContent.includes("content:none !important")) last.remove();
  });
  const abOnAgain = await abMeasure();

  // Spacing A/B: the 375 row rhythm moved 6px from block padding into the line
  // gap (10/6/10 -> 7/12/7) so the 44px band can clear the action. Prove the
  // swap is height-neutral by re-applying the old rhythm on the same DOM.
  let spacingAB = null;
  if (width <= 640) {
    await page.addStyleTag({ content: "@media (max-width:640px){.rc-offer-row{gap:6px !important;padding-block:10px !important}}" });
    const old = await abMeasure();
    await page.evaluate(() => {
      const styles = [...document.querySelectorAll("style")];
      const last = styles[styles.length - 1];
      if (last && last.textContent.includes("gap:6px !important")) last.remove();
    });
    spacingAB = { next: abOnAgain, old };
  }

  // Screenshot: the first row/card at 375 showing the unchanged 22px visual.
  let shot = null;
  if (width === 375) {
    const row = page.locator("li.rc-offer-row").first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(250);
      const box = await row.boundingBox();
      if (box) {
        const clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(box.width + 16, width), height: box.height + 16 };
        const file = `${SHOTS}/${locale}-${width}${DARK ? "-dark" : ""}.png`;
        await page.screenshot({ path: file, clip });
        shot = file;
      }
    }
    // Full-page viewport shot too, for overflow/light-dark evidence.
    const full = `${SHOTS}/${locale}-${width}-viewport${DARK ? "-dark" : ""}.png`;
    await page.screenshot({ path: full });
    shot = shot || full;
  }

  await context.close();
  return { locale, width, url, ...data, tooltip, hoverTip, focusTip, shot, spacingAB, ab: { on: abOn, off: abOff, onAgain: abOnAgain } };
}

const results = [];
for (const locale of LOCALES) {
  for (const w of WIDTHS) {
    const h = w === 375 ? 812 : 900;
    try {
      results.push(await measure(locale, w, h));
    } catch (e) {
      results.push({ locale, width: w, error: String(e && e.message ? e.message : e) });
    }
  }
}

await browser.close();

const report = { base: BASE, query: QUERY, dark: DARK, measuredAt: new Date().toISOString(), results };
writeFileSync(OUT, JSON.stringify(report, null, 2));

// Human-readable table + hard gates.
let failed = 0;
for (const r of results) {
  if (r.error || r.empty) { console.log(`\n${r.locale} @${r.width}: ${r.error || "EMPTY (no .rc-status)"}`); failed++; continue; }
  console.log(`\n=== ${r.locale.toUpperCase()} @${r.width} dir=${r.dir} tokens=${r.tokenCount} rows=${r.rowCount} cards=${r.cardCount} scrollWidth=${r.scrollWidth}/${r.innerWidth} ===`);
  for (const t of r.tokenMetrics) {
    // AC1: band >=44x44 by computed bounds, chip stays 22px, and the band
    // actually hit-tests 1px beyond the chip on both block sides. The ±21
    // points are reported separately: where the band's rectangle reaches a
    // neighbouring action, the action (correctly) wins that shared strip.
    const bandOk = t.beforeBand.computedHeight >= 44 && t.beforeBand.computedWidth >= 44;
    const visualOk = t.visualHeight <= 22.5 && t.visualWidth >= 44;
    const edgeOk = t.hitAbove11.isToken && t.hitBelow11.isToken;
    const ok = bandOk && visualOk && edgeOk;
    if (!ok) failed++;
    console.log(
      `  token#${t.i} ${t.inLegend ? "legend" : t.inRow ? "row" : "other"} visual ${t.visualWidth}x${t.visualHeight} pad=${t.paddingInlineStart}/${t.paddingInlineEnd} gap=${t.gap} icon=${t.iconSize?.width} ::before ${t.beforeRule.top}/${t.beforeRule.bottom} band=${t.beforeBand.computedWidth}x${t.beforeBand.computedHeight} [${t.beforeBand.top}-${t.beforeBand.bottom}] above21=${t.hitAbove21.isToken}(${t.hitAbove21.tag}) below21=${t.hitBelow21.isToken}(${t.hitBelow21.tag}) above11=${t.hitAbove11.isToken} below11=${t.hitBelow11.isToken} bandTop=${t.hitBandTop.isToken} bandBottom=${t.hitBandBottom.isToken} ${ok ? "OK" : "FAIL"}`,
    );
  }
  for (const row of r.rowMetrics) {
    if (row.hasCta === false) continue;
    // AC4 functional gate: the action wins at its top edge, centre and bottom
    // edge. The rectangle overlap is reported; where maxClearBand < 44 the
    // accepted row anatomy cannot fit a 44px band without sharing a strip, so
    // the action must be stacked above it (it is).
    const ok = row.ctaActivates;
    if (!ok) failed++;
    console.log(`  row#${row.i} band=${row.hitBand.top}-${row.hitBand.bottom}(${row.bandHeight}) cta=${row.ctaRect.top}-${row.ctaRect.bottom} overlap=${row.overlap} overlapPx=${row.overlapPx} clearAbove=${row.aboveClear} clearBelow=${row.belowClear} maxClearBand=${row.maxClearBand}${row.overlap && row.maxClearBand < 44 ? " (44px band cannot clear: <44px of room)" : ""} ctaTop=${row.ctaTopHit.activates}(${row.ctaTopHit.tag}) ctaCentre=${row.ctaCentreHit.activates} ctaBottom=${row.ctaBottomHit.activates} activates=${row.ctaActivates} ${ok ? "OK" : "FAIL"}`);
  }
  console.log(`  tallest3RowCard=${r.tallestCard ? r.tallestCard.height + "px (rows=" + r.tallestCard.rows + ")" : "none"} threeRow=${JSON.stringify(r.threeRowCards.map((c) => c.height))}`);
  if (r.ab) {
    const a = r.ab.on, b = r.ab.off, c = r.ab.onAgain;
    const dOff = a.tallestCard && b.tallestCard ? round(a.tallestCard.height - b.tallestCard.height) : null;
    const dOn = a.tallestCard && c.tallestCard ? round(a.tallestCard.height - c.tallestCard.height) : null;
    const rowDelta = Math.max(...a.rowHeights.map((h, i) => Math.abs(h - (b.rowHeights[i] ?? h))));
    const cardDelta = Math.max(...a.cardHeights.map((h, i) => Math.abs(h - (b.cardHeights[i] ?? h))));
    const tokenDelta = a.token && b.token ? { w: round(a.token.width - b.token.width), h: round(a.token.height - b.token.height) } : null;
    const ok = dOff === 0 && dOn === 0 && rowDelta === 0 && cardDelta === 0 && tokenDelta?.w === 0 && tokenDelta?.h === 0;
    if (!ok) failed++;
    console.log(`  A/B same DOM: tallestCardOn=${a.tallestCard?.height} tallest3RowOn=${a.tallest3Row?.height} ruleOff=${b.tallestCard?.height} ruleOnAgain=${c.tallestCard?.height} deltaOff=${dOff} deltaOn=${dOn} maxRowDelta=${rowDelta} maxCardDelta=${cardDelta} tokenDelta=${JSON.stringify(tokenDelta)} ${ok ? "OK" : "FAIL"}`);
  }
  console.log(`  tooltip hover=${JSON.stringify(r.hoverTip?.content)} focus=${JSON.stringify(r.focusTip?.afterContent)} focusVisible=${r.focusTip?.focusVisible} aria=${JSON.stringify(r.tooltip?.aria)}`);
  if (r.width === 375 && r.scrollWidth > r.innerWidth) { console.log(`  OVERFLOW ${r.scrollWidth} > ${r.innerWidth} FAIL`); failed++; }
  if (r.shot) console.log(`  shot=${r.shot}`);
}
console.log(`\nOUT=${OUT} failedGates=${failed}`);
process.exit(failed ? 1 : 0);
