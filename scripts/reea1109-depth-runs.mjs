#!/usr/bin/env node
/**
 * REEA-1109 — median-of-3 live depth runs for the PM's 11-query panel.
 *
 * Per the W48 review request: report before/after as a median of 3 runs per
 * query and name the `/__commit.txt` stamp for each run. One run oscillates
 * too much to prove a fix; this collector records every run's stamp, elapsed
 * time, rendered merchants, per-lane notes and payload cards so the offline
 * audit can fold the shelf-card depth exactly like the page does.
 *
 * Usage:
 *   node scripts/reea1109-depth-runs.mjs <baseUrl> <outFile> [runs]
 */
import { writeFileSync } from "node:fs";

const BASE = (process.argv[2] || process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.argv[3] || "reea1109-depth-runs.json";
const RUNS = Number(process.argv[4] || 3);

const QUERIES = [
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

const LANES = [
  "Xcite", "Jarir", "Eureka", "Sultan Center", "Lulu Hypermarket",
  "Aster Pharmacy", "Nahdi", "BinSina", "Ounass",
];

async function stamp() {
  try {
    const res = await fetch(`${BASE}/__commit.txt`, { signal: AbortSignal.timeout(15_000) });
    return (await res.text()).trim();
  } catch (err) {
    return `unreadable: ${String(err)}`;
  }
}

const samples = [];
for (const q of QUERIES) {
  for (let run = 1; run <= RUNS; run++) {
    const buildStamp = await stamp();
    const started = Date.now();
    let httpStatus = 0;
    let payload = null;
    let rawError = null;
    try {
      const res = await fetch(`${BASE}/api/results-followup?q=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(90_000),
      });
      httpStatus = res.status;
      const text = await res.text();
      payload = text ? JSON.parse(text) : null;
    } catch (err) {
      rawError = String(err);
    }
    const elapsed = Date.now() - started;

    const offersByMerchant = {};
    const productCards = [];
    for (const p of payload?.products ?? []) {
      const cardOffers = [];
      for (const o of p.offers ?? []) {
        offersByMerchant[o.merchant] = (offersByMerchant[o.merchant] ?? 0) + 1;
        cardOffers.push({
          merchant: o.merchant, price: o.price, currency: o.currency,
          url: o.url, collectedAt: o.collectedAt, inStock: o.inStock,
        });
      }
      productCards.push({
        title: p.title,
        merchants: [...new Set(cardOffers.map((o) => o.merchant))],
        offers: cardOffers,
      });
    }

    const notesByMerchant = {};
    for (const n of payload?.notes ?? []) notesByMerchant[n.merchant] = n;
    const lanes = {};
    for (const lane of LANES) {
      const n = notesByMerchant[lane];
      if (!n) {
        lanes[lane] = { state: "not_dispatched", hits: null, error: null, offers: 0 };
        continue;
      }
      const state = n.error ? "failed" : n.hits > 0 ? "answered" : "zero_offers";
      lanes[lane] = { state, hits: n.hits, error: n.error ?? null, offers: offersByMerchant[lane] ?? 0 };
    }

    const renderedMerchants = Object.keys(offersByMerchant);
    const record = {
      query: q, run, buildStamp, httpStatus, elapsedMs: elapsed,
      settled: payload?.settled ?? null,
      products: payload?.products?.length ?? 0,
      offers: (payload?.products ?? []).reduce((n, p) => n + (p.offers?.length ?? 0), 0),
      renderedMerchants,
      multiRetailerQueries: renderedMerchants.length >= 2,
      offersByMerchant,
      notes: (payload?.notes ?? []).map((n) => ({ merchant: n.merchant, hits: n.hits, error: n.error ?? null })),
      lanes, productCards, error: payload?.error ?? rawError,
    };
    record.multiRetailerCards = productCards.filter((c) => c.merchants.length >= 2).length;
    samples.push(record);
    console.error(
      `"${q}" run=${run} stamp=${buildStamp.slice(0, 7)} ${elapsed}ms products=${record.products} offers=${record.offers} merchants=${renderedMerchants.length} multiCards=${record.multiRetailerCards}/${productCards.length}`,
    );
  }
}

// Per-query medians (the measurement contract): elapsed and multi-card count.
const medians = {};
for (const q of QUERIES) {
  const rows = samples.filter((s) => s.query === q);
  const med = (vals) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  medians[q] = {
    elapsedMs: med(rows.map((r) => r.elapsedMs)),
    multiRetailerCards: med(rows.map((r) => r.multiRetailerCards)),
    cards: med(rows.map((r) => r.productCards.length)),
    merchants: med(rows.map((r) => r.renderedMerchants.length)),
    stamps: rows.map((r) => r.buildStamp),
  };
}

writeFileSync(
  OUT,
  JSON.stringify(
    { base: BASE, probedAt: new Date().toISOString(), runs: RUNS, queries: QUERIES, lanes: LANES, medians, samples },
    null,
    2,
  ),
);
console.error(`\nwrote ${OUT}`);
for (const q of QUERIES) {
  const m = medians[q];
  console.error(`${q.padEnd(24)} median ${m.elapsedMs}ms  multi ${m.multiRetailerCards}/${m.cards}  merchants ${m.merchants}  stamp ${[...new Set(m.stamps)].join(",")}`);
}
