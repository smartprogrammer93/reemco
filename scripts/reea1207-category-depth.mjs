/**
 * REEA-1207 (Bet 7B) — category comparison depth probe.
 *
 * Measures the SERVED results page for the fixed Bet 7B 11-query panel and
 * prints, per query, the dedup-corrected multi-retailer card ratio the ACs
 * gate on (AC 7B-1 / AC 7B-2): of the unique `productId` cards the page
 * paints, how many carry offers from >=2 distinct IN-MARKET (Kuwait) retailers.
 *
 * No arguments, no browser. Primary source is the rendered card's own
 * measurement contract — `data-product-id` / `data-comparison` /
 * `data-in-market-retailers` on each `<article class="result-card">`, emitted
 * by `ProductResultCard` from `comparisonMerchantCount` (the one in-market
 * integrity definition the weekly depth fold also reads). That counts the cards
 * the page actually painted, including snapshot replays. When a served head
 * predates those attributes the probe falls back to the page's per-product
 * JSON-LD (`sku`, `offers[].seller.name`) and labels the source, because the
 * JSON-LD only describes cards carrying a fresh eligible offer (fold 7 painted
 * 4 cards while its JSON-LD emitted none).
 *
 * Contract from the ticket:
 *   - the exact 11-query panel, no substitutions;
 *   - 3 runs;
 *   - `/__commit.txt` and `/api/health` recorded BEFORE each run;
 *   - per-query multi-retailer ratio printed, plus the median across runs.
 *
 * Viewport note: the card population is server-rendered, so 375 vs 1280 does
 * not change the ratio; the probe records the locale it rendered (en/ar via the
 * `rc_locale` cookie) and states the viewport basis in its output. QA's visual
 * 375/1280 checks (AC 7B-4 overflow) stay a browser job.
 *
 * Usage:
 *   node scripts/reea1207-category-depth.mjs
 *   BASE_URL=http://localhost:3000 node scripts/reea1207-category-depth.mjs
 *
 * Exit code is non-zero only when the probe could not measure (stamp or page
 * fetch failed), never because a ratio gate missed — the gates are reported.
 */
import { writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1207-category-depth.json";

/** The fixed Bet 7B panel — exactly these strings, no substitutions. */
const PANEL = [
  "iphone 17 pro",
  "fold 7",
  "samsung galaxy s25 ultra",
  "dyson",
  "nintendo switch 2",
  "air fryer",
  "laptop",
  "ps5",
  "cucumber",
  "panadol",
  "headphones",
];

const LOCALES = ["en", "ar"];
const RUNS = 3;
const CARD_GATE = 0.4;
/** Politeness: one page at a time, a short breath between them. */
const QUERY_GAP_MS = 400;
const PAGE_TIMEOUT_MS = 90_000;

/**
 * In-market = Kuwait. Mirrors `MERCHANT_MARKET` in
 * `src/lib/collect/coverage.ts`: only these three are non-Kuwait lanes, every
 * other adapter serves the Kuwait market the site compares for.
 */
const NON_KUWAIT = new Set(["Jarir", "Nahdi", "Danube Home", "Amazon.eg"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isInMarket(merchant) {
  return typeof merchant === "string" && merchant.trim() !== "" && !NON_KUWAIT.has(merchant);
}

async function fetchText(url, headers) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    cache: "no-store",
  });
  const body = await res.text();
  return { status: res.status, body };
}

/** Pull every Product JSON-LD node out of a served results page. */
function productNodes(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const nodes = [];
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (parsed && parsed["@type"] === "Product" && typeof parsed.sku === "string") {
      nodes.push(parsed);
    }
  }
  return nodes;
}

/**
 * REEA-1207 — the rendered card's own measurement contract: `data-product-id`,
 * `data-comparison` and `data-in-market-retailers` are emitted by
 * `ProductResultCard` from `comparisonMerchantCount` (the one in-market
 * integrity definition the weekly fold also reads). Reading them measures the
 * cards the page actually painted, including snapshot replays that emit no
 * JSON-LD, and never re-derives merchants from prose.
 */
function measureRendered(html) {
  const tagRe = /<article\b[^>]*>/g;
  const cards = new Map();
  let skipped = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const id = /data-product-id="([^"]+)"/.exec(tag)?.[1];
    if (!id) continue;
    // AC 7B-1 measures the COMPARISON shelf. The related-alternatives band
    // reuses the same card component, so a card only counts when its own
    // scope class is primary/variant (or unscoped on a pre-7A head).
    const scope = /data-product-scope="([^"]*)"/.exec(tag)?.[1] ?? "";
    if (scope === "accessory" || scope === "related") {
      skipped += 1;
      continue;
    }
    const comparison = /data-comparison="1"/.test(tag);
    const retailers = Number(/data-in-market-retailers="(\d+)"/.exec(tag)?.[1] ?? "0");
    const multi = comparison || retailers >= 2 ? 1 : 0;
    cards.set(id, Math.max(cards.get(id) ?? 0, multi));
  }
  const total = cards.size;
  const multi = [...cards.values()].filter((v) => v === 1).length;
  return {
    source: "rendered-card-attributes",
    skippedRelated: skipped,
    cards: total,
    multi,
    ratio: total === 0 ? 0 : multi / total,
    detail: [...cards.entries()].map(([sku, v]) => ({ sku, multi: v === 1 })),
  };
}

/** Fallback for a served head that predates the card attributes: JSON-LD
 *  nodes only describe cards carrying a fresh eligible offer, so replay cards
 *  are invisible to it (fold 7 measured 0 cards while the page painted 4). */
function measureJsonLd(html) {
  const nodes = productNodes(html);
  const cards = new Map();
  for (const node of nodes) {
    if (!cards.has(node.sku)) cards.set(node.sku, new Set());
    for (const offer of node.offers || []) {
      const merchant = offer?.seller?.name;
      if (isInMarket(merchant)) cards.get(node.sku).add(merchant);
    }
  }
  const total = cards.size;
  const multi = [...cards.values()].filter((set) => set.size >= 2).length;
  return {
    source: "json-ld-fallback",
    cards: total,
    multi,
    ratio: total === 0 ? 0 : multi / total,
    detail: [...cards.entries()].map(([sku, set]) => ({ sku, multi: set.size >= 2 })),
  };
}

function measure(html) {
  const rendered = measureRendered(html);
  return rendered.cards > 0 ? rendered : measureJsonLd(html);
}

async function readStamp() {
  const commit = await fetchText(`${BASE}/__commit.txt`, {});
  const health = await fetchText(`${BASE}/api/health`, { accept: "application/json" });
  let healthJson = null;
  try {
    healthJson = JSON.parse(health.body);
  } catch {
    healthJson = { raw: health.body.slice(0, 200) };
  }
  return {
    commitHttp: commit.status,
    commit: commit.body.trim(),
    healthHttp: health.status,
    health: healthJson,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const runs = [];

  for (let run = 1; run <= RUNS; run += 1) {
    const stamp = await readStamp();
    console.log(
      `\nRUN ${run} stamp: /__commit.txt HTTP ${stamp.commitHttp} → ${stamp.commit}; ` +
        `/api/health HTTP ${stamp.healthHttp} → ${JSON.stringify(stamp.health)}`,
    );
    if (stamp.commitHttp !== 200 || stamp.healthHttp !== 200) {
      throw new Error(`run ${run}: stamp read failed (commit ${stamp.commitHttp}, health ${stamp.healthHttp})`);
    }

    const perQuery = [];
    let totalCards = 0;
    let totalMulti = 0;

    for (const query of PANEL) {
      const byLocale = {};
      for (const locale of LOCALES) {
        const url = `${BASE}/results?q=${encodeURIComponent(query)}`;
        const { status, body } = await fetchText(url, {
          // The page is measured exactly as it is served: a memo/stale replay
          // is still a page produced by the CURRENT build (only its snapshot is
          // older), and forcing `rc_refresh=1` on every hop made the probe
          // itself trip the edge's 429s (66 cold fan-outs per run). The stamp is
          // recorded before each run so a mid-rollout head is visible.
          cookie: `rc_locale=${locale}`,
          "accept-language": locale === "ar" ? "ar" : "en",
        });
        if (status === 429) {
          // One polite retry: the edge rate-limits page requests in bursts.
          await sleep(2000);
          const retry = await fetchText(url, {
            cookie: `rc_locale=${locale}`,
            "accept-language": locale === "ar" ? "ar" : "en",
          });
          if (retry.status === 200) {
            byLocale[locale] = measure(retry.body);
            await sleep(QUERY_GAP_MS);
            continue;
          }
        }
        if (status !== 200) {
          console.log(`  ${query} [${locale}]: HTTP ${status} — no measurement`);
          byLocale[locale] = null;
          continue;
        }
        byLocale[locale] = measure(body);
        await sleep(QUERY_GAP_MS);
      }
      // The AC's panel basis is EN+AR at 375: each locale render is one served
      // page and is counted as such (its own unique productId denominator), so
      // the panel figure is the aggregate over both locales rather than a
      // union that would let one locale inflate the other's denominator.
      const cards = LOCALES.reduce((n, l) => n + (byLocale[l]?.cards ?? 0), 0);
      const multi = LOCALES.reduce((n, l) => n + (byLocale[l]?.multi ?? 0), 0);
      const ratio = cards === 0 ? 0 : multi / cards;
      totalCards += cards;
      totalMulti += multi;
      const sources = LOCALES.map((l) => byLocale[l]?.source).filter(Boolean);
      perQuery.push({
        query,
        cards,
        multi,
        ratio,
        en: byLocale.en ? { cards: byLocale.en.cards, multi: byLocale.en.multi } : null,
        ar: byLocale.ar ? { cards: byLocale.ar.cards, multi: byLocale.ar.multi } : null,
        source: sources.length ? [...new Set(sources)].join("+") : "none",
      });
      console.log(
        `  ${query}: cards ${cards} · multi-retailer ${multi} · ${pct(ratio)}` +
          ` [${perQuery[perQuery.length - 1].source}]` +
          (cards > 0 && ratio >= CARD_GATE ? "  [≥40%]" : ""),
      );
    }

    const panelRatio = totalCards === 0 ? 0 : totalMulti / totalCards;
    const queriesAtGate = perQuery.filter((q) => q.cards > 0 && q.ratio >= CARD_GATE).length;
    console.log(
      `  PANEL run ${run}: ${totalMulti}/${totalCards} = ${pct(panelRatio)} · queries ≥40%: ${queriesAtGate}/11`,
    );
    runs.push({ run, stamp, perQuery, panelRatio, totalCards, totalMulti, queriesAtGate });
  }

  const panelRatios = runs.map((r) => r.panelRatio);
  const medianRatio = median(panelRatios);
  const queriesAtGateMedian = median(runs.map((r) => r.queriesAtGate));
  const medianRunIndex = panelRatios.indexOf(medianRatio);
  const medianRun = runs[medianRunIndex] ?? runs[0];

  console.log("\n=== Bet 7B panel summary (median of 3 runs, EN+AR, 375 basis) ===");
  console.log(`stamps: ${runs.map((r) => r.stamp.commit).join(" | ")}`);
  console.log(`panel ratios per run: ${panelRatios.map(pct).join(" | ")}`);
  console.log(`MEDIAN panel multi-retailer ratio: ${pct(medianRatio)}  (AC 7B-1 gate ${pct(CARD_GATE)})`);
  console.log(
    `queries at ≥40% on median run: ${queriesAtGateMedian}/11  (AC 7B-2 gate ≥6/11)`,
  );
  console.log(
    `median run ${medianRun.run} per-query: ` +
      medianRun.perQuery.map((q) => `${q.query}=${pct(q.ratio)}`).join(", "),
  );
  console.log(`AC 7B-1 ${medianRatio >= CARD_GATE ? "PASS" : "FAIL"} · AC 7B-2 ${queriesAtGateMedian >= 6 ? "PASS" : "FAIL"}`);

  const payload = {
    ticket: "REEA-1207",
    base: BASE,
    panel: PANEL,
    locales: LOCALES,
    viewportBasis: "375 (server-rendered card population is viewport-independent)",
    runs,
    median: {
      panelRatio: medianRatio,
      queriesAtGate: queriesAtGateMedian,
      run: medianRun.run,
      perQuery: medianRun.perQuery,
    },
    acGate: { panel: medianRatio >= CARD_GATE, queries: queriesAtGateMedian >= 6 },
  };
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nfull payload: ${OUT}`);
}

main().catch((err) => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
