/**
 * REEA-280 evidence run — duplicate-card audit over the rendered results
 * surface (curl-only: the staged SSR shell carries every card, so plain
 * fetch sees exactly what a shopper sees; no browser needed).
 *
 * Method, per query:
 *  - `cards`     — unique rendered `<article class="result-card">` titles
 *    (hydration shows one merged snapshot, so repeated flushes of the same
 *    card count once, exactly as a browser renders them);
 *  - `listings`  — Σ per-card "N retailers · from" figure = the count of
 *    distinct retailer listings fetched for the query — the pre-merge card
 *    count when every title formed its own card;
 *  - reduction   — 1 − cards/listings, i.e. the share of would-be duplicate
 *    cards the same-SKU merge collapsed (AC-1 bar: ≥80% overall);
 *  - residual    — pairs of RENDERED cards still sharing one SKU tuple under
 *    the merge rule (brand/model-line/storage/grade agree, colors ride
 *    inside the card). Near-zero residual proves the merge is applied, not
 *    just implemented; distinct storage/colour variants counting as separate
 *    cards is expected and checked by the tuple fields themselves.
 *
 * Usage: QA_BASE_URL=https://reemco.vercel.app node scripts/reaa280-audit.mjs
 * Extra CLI args replace the default 20-query top-market list.
 */
import { canonicalFields, compatibleFields } from "../src/lib/collect/canonical-product.ts";

const BASE = (process.env.QA_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");

const DEFAULT_QUERIES = [
  "iPhone 17 Pro Max",
  "iPhone 16",
  "AirPods Pro",
  "Samsung Galaxy S25 Ultra",
  "Samsung Galaxy A56",
  "Xiaomi Redmi Note 14",
  "Sony WH-1000XM6",
  "JBL Charge 5",
  "Google Pixel 9a",
  "iPad Air",
  "Apple Watch Series 11",
  "LG gram",
  "Dyson Airwrap",
  "Nothing Phone (3a)",
  "Anker charger",
  "Sony TV 65",
  "آيفون 17",
  "غسالة",
  "ساعة ذكية",
  "مكنسة كهربائية",
];

/** Mirror of live-search's merge gate: colors ride inside one model+storage
 *  card (REEA-254), so two cards only count as a missed merge when they agree
 *  with colors ignored — unless neither side says model line or storage,
 *  where the color IS the visible variant label. */
function shouldHaveMerged(a, b) {
  if (!compatibleFields({ ...a, color: "" }, { ...b, color: "" })) return false;
  if (a.modelLine === "" && b.modelLine === "" && a.storage === "" && b.storage === "") {
    return compatibleFields(a, b);
  }
  return true;
}

async function auditQuery(query) {
  const url = `${BASE}/results?q=${encodeURIComponent(query)}`;
  // Each hop gets its own bounded window (same citizenship idea as the
  // per-retailer adapter timeouts): a stalled response aborts instead of
  // hanging the whole audit past the heartbeat budget.
  const res = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${query}: HTTP ${res.status}`);
  const html = await res.text();

  const parts = html.split('<article class="result-card');
  parts.shift();
  // Staged SSR streams each flush as its own block; with the per-arrival
  // gates (REEA-277) a card can appear in several flushes. Hydration shows
  // ONE merged snapshot, so count every unique card once — take its retailer
  // figure from the first (smallest) occurrence like the browser does.
  const seen = new Map();
  for (const part of parts) {
    // Rendered JSX separates the count span from its word with a React
    // comment node (`<!-- -->`), so the match must tolerate it.
    const m = />(\d+)<\/span>\s*(?:<!-- -->)?\s*(?:retailers|retailer)\b/.exec(part);
    const h = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(part);
    // Decode the entity marks React writes into the markup — the collector
    // saw the decoded string, so the tuple must be computed from it too.
    const title = h
      ? h[1]
          .replace(/<[^>]*>/g, "")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    if (!seen.has(title)) seen.set(title, m ? Number(m[1]) : 0);
  }
  let listings = 0;
  const titles = [];
  for (const [title, count] of seen) {
    titles.push(title);
    listings += count;
  }
  const cards = titles.length;

  let residual = 0;
  const fields = titles.map((t) => canonicalFields(t));
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      if (shouldHaveMerged(fields[i], fields[j])) residual++;
    }
  }
  return { query, cards, listings, residual, titles };
}

const queries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_QUERIES;
// Bounded-parallel fan-out (four at a time, polite to the origin): the
// sequential chain of ~4 s staged-SSR renders is what stretched the audit
// past its heartbeat window before; per-query results keep the list order.
const LIMIT = 4;
const rows = [];
{
  let next = 0;
  const results = new Array(queries.length);
  async function worker() {
    while (next < queries.length) {
      const i = next++;
      try {
        results[i] = await auditQuery(queries[i]);
      } catch (err) {
        console.error(`FAIL ${queries[i]}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, queries.length) }, worker));
  rows.push(...results.filter(Boolean));
}
let totCards = 0;
let totListings = 0;
let totResidual = 0;
for (const r of rows) {
  totCards += r.cards;
  totListings += r.listings;
  totResidual += r.residual;
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("query", 26), pad("cards", 7), pad("listings", 10), pad("reduce", 8), "residual");
for (const r of rows) {
  const red = r.listings > 0 ? (1 - r.cards / r.listings) * 100 : 0;
  console.log(
    pad(r.query, 26),
    pad(r.cards, 7),
    pad(r.listings, 10),
    pad(`${red.toFixed(1)}%`, 8),
    String(r.residual),
  );
}
const overall = totListings > 0 ? (1 - totCards / totListings) * 100 : 0;
console.log(
  `\n${rows.length} queries · ${totCards} cards over ${totListings} listings ` +
    `· duplicate-card reduction ${overall.toFixed(1)}% (AC bar ≥80%) · residual split pairs ${totResidual}`,
);
