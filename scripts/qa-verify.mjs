/**
 * REEA-101 QA verification: Aurora design v3 + realtime-policy on live sites.
 * Usage: QA_BASE_URL=https://... node scripts/qa-verify.mjs
 * Writes evidence JSON to QA_EVIDENCE path (default /work/scratch/evidence.json).
 *
 * Bootstrap notes (this container): @sparticuz/chromium needs the extracted
 * al2023 libs + sqlite shim on LD_LIBRARY_PATH, HOME=/tmp, FONTCONFIG_PATH,
 * and `--headless=new` appended to chromium.args. Without the sqlite shim the
 * NSS init hits a FATAL and every https navigation dies instantly.
 */
import { existsSync, writeFileSync } from "node:fs";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.QA_BASE_URL || "https://reemco-price-compare-preview.surge.sh").replace(/\/$/, "");
const EVIDENCE_PATH = process.env.QA_EVIDENCE || "/work/scratch/evidence.json";

process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const ev = { base: BASE, design: {}, realtime: {}, notes: [] };

let browser = null;
let keeper = null;
async function ensureBrowser() {
  if (browser && browser.isConnected && browser.isConnected()) return browser;
  browser = await pw.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args, "--headless=new"],
    headless: true,
  });
  // With --no-startup-window the process quits when the last page closes, so
  // keep one blank keeper page open for the whole run.
  keeper = await browser.newPage();
  await keeper.goto("about:blank");
  return browser;
}

// Shared in-page collector (runs via page.evaluate): mirrors useCollection's
// POST -> GET-poll -> ?wait=1 fallback so we always get a terminal snapshot.
async function collectJobInPage(pid) {
  let job = null;
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(pid)}/collect`, { method: "POST" });
    job = await r.json().catch(() => null);
  } catch {}
  const jobId = job && job.jobId;
  if (jobId) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const g = await fetch(`/api/collect-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        if (g.ok) {
          const snap = await g.json();
          if (snap && snap.status) job = snap;
          if (job && job.status !== "collecting") return job;
        }
      } catch {}
    }
  }
  try {
    const w = await fetch(`/api/products/${encodeURIComponent(pid)}/collect?wait=1`, { method: "POST" });
    const snap = await w.json();
    if (snap && snap.status) return snap;
  } catch {}
  return job;
}

async function timed(fn, label) {
  const t0 = Date.now();
  try {
    const v = await fn();
    ev.notes.push(`${label} ok in ${Date.now() - t0}ms`);
    return v;
  } catch (e) {
    ev.notes.push(`${label} ERROR: ${String(e.message).split("\n")[0]}`);
    return null;
  }
}

/* ---------- in-page helpers ---------- */
const inPageContrast = () => {
  function parseColor(c) {
    if (!c) return null;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((s) => parseFloat(s.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    const hm = c.match(/^#([0-9a-f]{6})$/i);
    if (hm) {
      const n = parseInt(hm[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    return null;
  }
  function lum(c) {
    const p = typeof c === "string" ? parseColor(c) : c;
    if (!p) return null;
    const [r, g, b] = [p.r, p.g, p.b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // effective opaque background: composite the ancestor chain (alpha-blend).
  // Inside the hero band, the base is the gradient midpoint and composition
  // starts at the hero band itself (body's canvas color must not leak through).
  function bgOf(el) {
    const hero = parseColor("#4f46e5");
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.unshift(n);
    let startIdx = chain.findIndex((n) => n.classList && n.classList.contains && n.classList.contains("hero-band"));
    let cur;
    if (startIdx >= 0) cur = hero;
    else {
      startIdx = chain.findIndex((n) => n.tagName === "BODY");
      cur = parseColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      if (startIdx < 0) startIdx = 0;
    }
    for (let i = Math.max(startIdx, 0); i < chain.length; i++) {
      const p = parseColor(getComputedStyle(chain[i]).backgroundColor);
      if (!p || p.a <= 0) continue;
      const a = Math.min(1, p.a);
      cur = { r: p.r * a + cur.r * (1 - a), g: p.g * a + cur.g * (1 - a), b: p.b * a + cur.b * (1 - a), a: 1 };
    }
    return cur;
  }
  function ratio(fg, bg) {
    const la = lum(fg);
    const lb = lum(bg);
    if (la == null || lb == null) return null;
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  }
  const cs = getComputedStyle;
  const pairs = {};
  const title = document.querySelector(".hero-title");
  if (title) pairs.headline_on_hero = ratio(cs(title).color, parseColor("#4f46e5"));
  pairs.body_on_canvas = ratio(cs(document.body).color, bgOf(document.body));
  const surface = document.querySelector(".result-card") || document.querySelector("main") || document.body;
  pairs.card_text_on_surface = ratio(cs(surface).color, bgOf(surface));
  const chipDone = document.querySelector(".rc-chip.is-done");
  if (chipDone) pairs.chip_done_text_on_chip = ratio(cs(chipDone).color, bgOf(chipDone));
  const chipIdle = document.querySelector(".rc-chip:not(.is-done)");
  if (chipIdle) pairs.chip_text_on_surface = ratio(cs(chipIdle).color, bgOf(chipIdle));
  const pill = document.querySelector(".query-pill");
  if (pill) pairs.pill_text_on_pill = ratio(cs(pill).color, bgOf(pill));
  const bestFlag = document.querySelector(".best-flag");
  if (bestFlag) pairs.best_flag_on_band = ratio(cs(bestFlag).color, bgOf(bestFlag));
  const btn = document.querySelector(".btn-primary");
  if (btn) pairs.btn_text_on_btn = ratio(cs(btn).color, bgOf(btn));
  return pairs;
};

/* ---------- design checks (home + results at >=1280px) ---------- */
await timed(async () => {
  const b = await ensureBrowser();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  ev.design.hero_headline_px = await page.$eval(".hero-title", (el) => parseFloat(getComputedStyle(el).fontSize)).catch(() => null);
  ev.design.contrast_home = await page.evaluate(inPageContrast);
  ev.design.focus_probe = await page.evaluate(() => {
    const out = {};
    const probe = (el, key) => {
      if (!el) return;
      const before = getComputedStyle(el).boxShadow;
      el.focus();
      const after = getComputedStyle(el).boxShadow;
      out[key] = { focused: document.activeElement === el, ringChanged: before !== after, boxShadow: after };
    };
    probe(document.querySelector("input"), "input");
    probe(document.querySelector("button"), "button");
    probe(document.querySelector("a[href]"), "link");
    return out;
  });
  ev.design.gradient_elements_home = await page.evaluate(() => {
    const seen = [];
    for (const el of document.querySelectorAll("*")) {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg.includes("linear-gradient")) {
        seen.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 40) });
      }
    }
    return seen.slice(0, 12);
  });
  await page.close();
}, "design/home");

await timed(async () => {
  const b = await ensureBrowser();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  await page.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "commit" });
  await page.waitForSelector(".result-card a[href]", { timeout: 15000 });

  // AC-2 + AC-6: per-card largest font element == effective price >= 28px
  ev.design.card_font_audit = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".result-card")].filter((c) => c.querySelector("a[href]"));
    return cards.slice(0, 6).map((card) => {
      let max = 0, maxEl = null;
      const walk = (el) => {
        for (const c of el.children) {
          const fs = parseFloat(getComputedStyle(c).fontSize) || 0;
          if (fs > max) { max = fs; maxEl = c; }
          walk(c);
        }
      };
      walk(card);
      return { maxPx: max, maxText: String(maxEl && maxEl.textContent || "").trim().slice(0, 30), looksLikePrice: /\d/.test(String(maxEl && maxEl.textContent || "")) };
    });
  });

  ev.design.contrast_results = await page.evaluate(inPageContrast);

  // AC-4 hover lift elev-1 -> elev-2 + translateY(-2px)
  const beforeHover = await page.$eval(".result-card", (el) => {
    const cs = getComputedStyle(el);
    return { shadow: cs.boxShadow, transform: cs.transform };
  });
  await page.hover(".result-card");
  await page.waitForTimeout(350);
  const afterHover = await page.$eval(".result-card", (el) => {
    const cs = getComputedStyle(el);
    return { shadow: cs.boxShadow, transform: cs.transform };
  });
  ev.design.hover = { before: beforeHover, after: afterHover, lifted: afterHover.transform.includes("-2") && afterHover.shadow !== beforeHover.shadow };

  ev.design.focus_results = await page.evaluate(() => {
    const out = {};
    const btn = document.querySelector("button");
    if (btn) { btn.focus(); out.button = getComputedStyle(btn).boxShadow; }
    const inp = document.querySelector("input");
    if (inp) { inp.focus(); out.input = getComputedStyle(inp).boxShadow; }
    const link = document.querySelector(".result-card a[href]");
    if (link) { link.focus(); out.cardLink = getComputedStyle(link).boxShadow; }
    return out;
  });

  ev.design.gradient_elements_results = await page.evaluate(() => {
    const seen = [];
    for (const el of document.querySelectorAll("*")) {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg.includes("linear-gradient")) seen.push({ cls: String(el.className || "").slice(0, 40) });
    }
    return seen.slice(0, 12);
  });
  await page.close();
}, "design/results");

// reduced-motion hover: lift disabled cleanly
await timed(async () => {
  const b = await ensureBrowser();
  const rm = await b.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  rm.setDefaultTimeout(15000);
  await rm.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "load" });
  await rm.waitForSelector(".result-card a[href]", { timeout: 15000 });
  await rm.hover(".result-card");
  await rm.waitForTimeout(250);
  ev.design.reduced_motion_hover = await rm.evaluate(() => {
    const card = document.querySelector(".result-card");
    if (!card) return null;
    const cs = getComputedStyle(card);
    return { transform: cs.transform, transitionDuration: cs.transitionDuration };
  });
  await rm.close().catch(() => {});
}, "design/reduced-motion");

/* ---------- realtime checks ---------- */
// Shared in-page routine: open product detail, wait for live collection to
// land, return job JSON (machine timestamps) + timing + cookie surface.
async function liveVisit(opts = {}) {
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  const headers = [];
  p.on("response", (r) => headers.push({ path: new URL(r.url()).pathname, sc: !!r.headers()["set-cookie"] }));
  const t0 = Date.now();
  await p.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "commit" });
  await p.waitForSelector(".result-card a[href^='/product/']", { timeout: 15000 });
  const href = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  await p.goto(`${BASE}${href}`, { waitUntil: "commit" });
  const firstMs = await p.evaluate(async () => {
    const t = Date.now();
    while (Date.now() - t < 9000) {
      if (document.querySelectorAll(".rc-chip.is-done").length > 0 || document.querySelectorAll(".pulse-cascade .result-card").length > 0) return Date.now() - t;
      await new Promise((r) => setTimeout(r, 50));
    }
    return Date.now() - t;
  });
  const fullMs = await p.evaluate(async () => {
    const settled = () => {
      const chips = [...document.querySelectorAll(".rc-chip")];
      if (chips.length && chips.every((c) => c.getAttribute("data-status") !== "collecting")) return true;
      return /Collection complete/i.test(document.body.innerText) && document.querySelectorAll(".pulse-cascade .result-card").length > 0;
    };
    const t = Date.now();
    while (Date.now() - t < 9000) {
      if (settled()) return Date.now() - t;
      await new Promise((r) => setTimeout(r, 50));
    }
    return Date.now() - t;
  });
  const job = await p.evaluate(async () => {
    const pid = location.pathname.split("/").filter(Boolean).pop();
    // mirrors useCollection: POST -> poll GET; on cross-instance 404 miss,
    // fall back to the synchronous ?wait=1 snapshot (same as the shipped hook)
    let job = null;
    try {
      const r = await fetch(`/api/products/${encodeURIComponent(pid)}/collect`, { method: "POST" });
      job = await r.json().catch(() => null);
    } catch {}
    const jobId = job && job.jobId;
    if (jobId) {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const g = await fetch(`/api/collect-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (g.ok) {
            job = await g.json();
            if (job && job.status !== "collecting") return job;
          }
        } catch {}
      }
    }
    try {
      const w = await fetch(`/api/products/${encodeURIComponent(pid)}/collect?wait=1`, { method: "POST" });
      return await w.json();
    } catch {
      return job;
    }
  });
  const panelText = await p.evaluate(() => document.body.innerText.slice(0, 600));
  const cookieState = await p.evaluate(() => ({ cookie: document.cookie, ls: localStorage.length, ss: sessionStorage.length }));
  const htmlLen = (await p.content()).length;
  await ctx.close().catch(() => {});
  return { firstMs, fullMs, job, panelText, cookieState, headers, href, htmlLen, wallMs: Date.now() - t0 };
}

await timed(async () => {
  const v1 = await liveVisit();
  await new Promise((r) => setTimeout(r, 700));
  const v2 = await liveVisit();
  const j1 = v1.job || {}; const j2 = v2.job || {};
  const ts1 = j1.finishedAt || j1.startedAt;
  const ts2 = j2.finishedAt || j2.startedAt;
  ev.realtime.visit1 = { firstMs: v1.firstMs, fullMs: v1.fullMs, ts: ts1 || null, status: j1.status || null, href: v1.href };
  ev.realtime.visit2 = { firstMs: v2.firstMs, fullMs: v2.fullMs, ts: ts2 || null, status: j2.status || null };
  ev.realtime.timestamps_advance = ts1 && ts2 ? Date.parse(ts2) >= Date.parse(ts1) : null;
  ev.realtime.cookie_state = v2.cookieState;
  ev.realtime.set_cookie_paths = [...new Set([...v1.headers, ...v2.headers].map((h) => `${h.path}=${h.sc ? "yes" : "no"}`))].slice(0, 15);
  ev.realtime.html_len = v2.htmlLen;
}, "rt/two-visits");

// RT AC-4: machine per-offer collectedAt vs server clock (+-5s)
await timed(async () => {
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  await p.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "commit" });
  await p.waitForSelector(".result-card a[href^='/product/']", { timeout: 15000 });
  const href = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  await p.goto(`${BASE}${href}`, { waitUntil: "commit" });
  await p.waitForFunction(() => {
    const chips = [...document.querySelectorAll(".rc-chip")];
    if (chips.length && chips.every((c) => c.getAttribute("data-status") !== "collecting")) return true;
    return /Collection complete/i.test(document.body.innerText) && document.querySelectorAll(".pulse-cascade .result-card").length > 0;
  }, null, { timeout: 12000 }).catch(() => {});
  const info = await p.evaluate(async () => {
    const pid = location.pathname.split("/").filter(Boolean).pop();
    let job = null;
    try {
      const r = await fetch(`/api/products/${encodeURIComponent(pid)}/collect`, { method: "POST" });
      job = await r.json().catch(() => null);
    } catch {}
    const jobId = job && job.jobId;
    if (jobId) {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const g = await fetch(`/api/collect-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (g.ok) {
            const snap = await g.json();
            if (snap && snap.status) job = snap;
            if (job && job.status !== "collecting") break;
          }
        } catch {}
      }
    }
    if (!job || job.status === "collecting") {
      try {
        const w = await fetch(`/api/products/${encodeURIComponent(pid)}/collect?wait=1`, { method: "POST" });
        const snap = await w.json();
        if (snap && snap.status) job = snap;
      } catch {}
    }
    return { pid, job, hasCollectedLine: /collected/i.test(document.body.innerText) };
  });
  const ref = await p.evaluate(async () => {
    const r = await fetch("/");
    const d = r.headers.get("date") || new Date().toUTCString();
    return { dateHeader: d, at: Date.now() };
  });
  const srvMs = Date.parse(ref.dateHeader) || ref.at;
  const job = info.job || {};
  const offers = job.offers || [];
  const diffs = offers.map((o) => Math.abs(Date.parse(o.collectedAt || job.finishedAt || job.startedAt) - srvMs));
  ev.realtime.timestamp_check = {
    offersCount: offers.length,
    offersWithCollectedAt: offers.filter((o) => !!o.collectedAt).length,
    maxDiffMsVsServer: diffs.length ? Math.max(...diffs) : null,
    collectedLineVisible: info.hasCollectedLine,
    jobStatus: job.status || null,
  };
  await ctx.close().catch(() => {});
}, "rt/timestamps");

// RT AC-3 cached label lifecycle + RT AC-2 arrival staging on product page
await timed(async () => {
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  await p.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "commit" });
  await p.waitForSelector(".result-card a[href^='/product/']", { timeout: 15000 });
  const href = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  // arrival staging samples on product page
  await p.goto(`${BASE}${href}`, { waitUntil: "commit" });
  const samples = [];
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const s = await p.evaluate(() => {
      const chips = [...document.querySelectorAll(".rc-chip")];
      return {
        chips: chips.length,
        done: chips.filter((c) => c.classList.contains("is-done")).length,
        cards: document.querySelectorAll(".pulse-cascade .result-card").length,
        complete: /Collection complete/i.test(document.body.innerText),
      };
    });
    samples.push({ dt: Date.now() - (samples.length ? samples[samples.length - 1].abs : Date.now()), chips: s.chips, done: s.done, cards: s.cards, complete: s.complete });
    if ((s.chips > 0 && s.done >= s.chips) || s.complete) break;
    await p.waitForTimeout(110);
  }
  // normalize dt relative to first sample
  const rel = samples.map((s, i) => ({ i, chips: s.chips, done: s.done, cards: s.cards, complete: s.complete }));
  ev.realtime.arrival_samples = rel.slice(0, 25);
  ev.realtime.arrival_distinct_done = [...new Set(rel.map((s) => s.done))].length;
  ev.realtime.arrival_distinct_cards = [...new Set(rel.map((s) => s.cards))].length;

  // settle, then SPA-navigate away + back within same tab session -> cached
  // label (module-level sessionJobs map survives client-side route changes)
  await p.waitForFunction(() => {
    const chips = [...document.querySelectorAll(".rc-chip")];
    if (chips.length && chips.every((c) => c.getAttribute("data-status") !== "collecting")) return true;
    return /Collection complete/i.test(document.body.innerText) && document.querySelectorAll(".pulse-cascade .result-card").length > 0;
  }, null, { timeout: 10000 }).catch(() => {});
  await p.click('a[href^="/results?q="]');
  await p.waitForSelector(".result-card a[href^='/product/']", { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(300);
  await p.click(".result-card a[href^='/product/']").catch(() => {});
  const labelSeen = await p.evaluate(async () => {
    const t = Date.now();
    while (Date.now() - t < 4000) {
      const txt = document.body.innerText;
      const m = txt.match(/[^\n]*cached[^\n]*/i);
      if (m) return { seen: true, ms: Date.now() - t, sample: m[0].slice(0, 90) };
      await new Promise((r) => setTimeout(r, 30));
    }
    return { seen: false, ms: null };
  });
  ev.realtime.cached_label_same_tab = labelSeen;

  const labelClears = await p.evaluate(async () => {
    const t = Date.now();
    while (Date.now() - t < 9000) {
      if (!/[Cc]ached/.test(document.body.innerText)) return { cleared: true, ms: Date.now() - t };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { cleared: false, ms: null };
  });
  ev.realtime.cached_label_clears = labelClears;

  // hard refresh -> fully fresh (no cached label during first paint window)
  await p.reload({ waitUntil: "commit" });
  const freshAfterReload = await p.evaluate(async () => {
    const seen = [];
    const t = Date.now();
    while (Date.now() - t < 2500) {
      seen.push(/[Cc]ached/.test(document.body.innerText));
      await new Promise((r) => setTimeout(r, 80));
    }
    return { anyCachedLabel: seen.some(Boolean), samples: seen.length };
  });
  ev.realtime.reload_is_fresh = freshAfterReload;
  await ctx.close().catch(() => {});
}, "rt/cache-label");

// RT AC-5 all-failure: api unavailable -> retry/error within ceiling, never blank
await timed(async () => {
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  await p.route("**/api/**", (route) => route.abort());
  await p.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "commit" });
  await p.waitForSelector(".result-card a[href^='/product/']", { timeout: 15000 });
  const href = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  const t0 = Date.now();
  await p.goto(`${BASE}${href}`, { waitUntil: "commit" });
  const alertMs = await p.evaluate(async () => {
    const t = Date.now();
    while (Date.now() - t < 8000) {
      const a = document.querySelector("[role='alert']");
      if (a && a.textContent && a.textContent.trim().length > 0) return Date.now() - t;
      const cta = [...document.querySelectorAll("button")].some((b) => /(retry|collect now)/i.test(b.textContent || ""));
      if (cta) return Date.now() - t;
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  });
  const neverBlank = await p.evaluate(() => !!document.querySelector(".result-card, header"));
  const retryBtn = await p.evaluate(() => [...document.querySelectorAll("button")].some((b) => /(retry|collect now)/i.test(b.textContent || "")));
  ev.realtime.all_failure = { alertMs, neverBlank, retryButton: retryBtn };
  await p.unroute("**/api/**");
  const recovered = await p.evaluate(async () => {
    const btn = [...document.querySelectorAll("button")].find((b) => /(retry|collect now)/i.test(b.textContent || ""));
    if (btn) btn.click();
    const t = Date.now();
    while (Date.now() - t < 10000) {
      if (document.querySelector(".rc-chip") || /Collection complete/i.test(document.body.innerText)) return Date.now() - t;
      await new Promise((r) => setTimeout(r, 80));
    }
    return null;
  });
  ev.realtime.retry_recovery_ms = recovered;
  await ctx.close().catch(() => {});
}, "rt/all-failure");

// RT AC-5 staggered arrival evidence: slow the poll response so the in-flight
// chip state is observable; capture mixed chip states + card rise steps.
await timed(async () => {
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  await p.route("**/api/collect-jobs/**", async (route) => {
    try {
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ response: res });
    } catch { await route.continue().catch(() => {}); }
  });
  await p.goto(`${BASE}/results?q=iPhone%2017%20Pro`, { waitUntil: "commit" });
  await p.waitForSelector(".result-card a[href^='/product/']", { timeout: 25000 });
  const href = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  await p.goto(`${BASE}${href}`, { waitUntil: "commit" });
  const samples = await p.evaluate(async () => {
    const out = [];
    const t = Date.now();
    while (Date.now() - t < 9000) {
      const chips = [...document.querySelectorAll(".rc-chip")];
      const done = chips.filter((c) => c.classList.contains("is-done"));
      const cs = done.length ? getComputedStyle(done[0]) : null;
      out.push({
        ms: Date.now() - t,
        chips: chips.length,
        done: done.length,
        cards: document.querySelectorAll(".pulse-cascade .result-card").length,
        complete: /Collection complete/i.test(document.body.innerText),
        chipDoneStyle: cs ? { color: cs.color, bg: cs.backgroundColor } : null,
      });
      const last = out[out.length - 1];
      if (last.complete || (last.chips > 0 && last.done === last.chips)) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    return out;
  });
  ev.realtime.stagger_samples = samples.filter((_, i) => i % 2 === 0).slice(0, 30);
  ev.realtime.stagger_mixed_chip_states = new Set(samples.map((s) => `${s.chips}/${s.done}`)).size;
  ev.realtime.stagger_card_steps = new Set(samples.map((s) => s.cards)).size;
  ev.realtime.chip_done_colors = (samples.find((s) => s.chipDoneStyle) || {}).chipDoneStyle || null;
  await ctx.close().catch(() => {});
}, "rt/stagger");

// RT AC-6 budgets: 10 queries -> first-offer / full-set times + per-adapter + region
await timed(async () => {
  const queries = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard", "sony", "samsung", "dyson", "jbl", "logitech", "anker", "apple watch"];
  const rows = [];
  const b = await ensureBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  let firstHref = null;
  for (const q of queries) {
    try {
      await p.goto(`${BASE}/results?q=${encodeURIComponent(q)}`, { waitUntil: "commit" });
      await p.waitForSelector(".result-card", { timeout: 25000 });
    } catch (e) {
      rows.push({ q, firstMs: null, fullMs: null, note: String(e.message).split("\n")[0] });
      continue;
    }
    if (!firstHref) firstHref = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href")).catch(() => null);
    // measure live-collection budgets on the first product card of each query page
    const href = await p.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href")).catch(() => firstHref);
    if (!href) { rows.push({ q, firstMs: null, fullMs: null }); continue; }
    await p.goto(`${BASE}${href}`, { waitUntil: "commit" });
    const firstMs = await p.evaluate(async () => {
      const t = performance.now();
      while (performance.now() - t < 9000) {
        if (document.querySelectorAll(".rc-chip.is-done").length > 0 || document.querySelectorAll(".pulse-cascade .result-card").length > 0) return Math.round(performance.now() - t);
        await new Promise((r) => setTimeout(r, 40));
      }
      return Math.round(performance.now() - t);
    });
    const fullMs = await p.evaluate(async () => {
      const settled = () => {
        const chips = [...document.querySelectorAll(".rc-chip")];
        if (chips.length && chips.every((c) => c.getAttribute("data-status") !== "collecting")) return true;
        return /Collection complete/i.test(document.body.innerText) && document.querySelectorAll(".pulse-cascade .result-card").length > 0;
      };
      const t = performance.now();
      while (performance.now() - t < 9000) {
        if (settled()) return Math.round(performance.now() - t);
        await new Promise((r) => setTimeout(r, 40));
      }
      return Math.round(performance.now() - t);
    });
    rows.push({ q, href, firstMs, fullMs });
  }
  const jobInfo = firstHref ? await p.evaluate(async (h) => {
    const pid = h.split("/").filter(Boolean).pop();
    try {
      const r = await fetch(`/api/products/${encodeURIComponent(pid)}/collect?wait=1`, { method: "POST" });
      return await r.json();
    } catch { return null; }
  }, firstHref) : null;
  ev.realtime.budget_rows = rows.map((r) => ({ q: r.q, firstMs: r.firstMs, fullMs: r.fullMs }));
  ev.realtime.first_offer_ms = rows.map((r) => r.firstMs).filter((v) => typeof v === "number").sort((a, b) => a - b);
  ev.realtime.full_set_ms = rows.map((r) => r.fullMs).filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (jobInfo) {
    ev.realtime.per_adapter = (jobInfo.subtasks || []).map((s) => ({ retailer: s.retailer, status: s.status }));
    ev.realtime.merchants = [...new Set((jobInfo.offers || []).map((o) => o.merchant))];
    ev.realtime.currencies = [...new Set((jobInfo.offers || []).map((o) => o.currency))];
    ev.realtime.job_finishedAt = jobInfo.finishedAt || null;
    ev.realtime.job_status = jobInfo.status || null;
  }
  await ctx.close().catch(() => {});
}, "rt/budgets");

// served HTML seed-content check (layout chrome only beyond hydration)
await timed(async () => {
  const raw = await (await fetch(`${BASE}/results?q=iPhone%2017%20Pro`)).text();
  const bodyOnly = raw.replace(/<script[\s\S]*?<\/script>/g, "");
  ev.realtime.served_html = {
    len: raw.length,
    bodyAfterScripts: bodyOnly.replace(/\s+/g, " ").trim().slice(0, 300),
    offerRowsInHtml: (bodyOnly.match(/in stock|Best price/gi) || []).length,
  };
}, "rt/served-html");

if (browser) await browser.close();

writeFileSync(EVIDENCE_PATH, JSON.stringify(ev, null, 2));
console.log(JSON.stringify(ev.notes));
