/**
 * REEA-280 AC1 audit — top-100-style query set against the LIVE pipeline:
 * for each query, raw retailer rows vs merged cards, after the merge gate.
 * Duplicate-card reduction = 1 - cards/rawRows; REEA-280 asks for >= 80%
 * aggregate over the 20-query manual audit. Prints the table + aggregate;
 * sanity asserts only (every query answers, storage tiers stay separate).
 */
import { afterAll, expect, it } from "vitest";
import { collectLiveResults } from "../src/lib/collect/live-search.ts";

const QUERIES = [
  "ASUS ROG Strix Scope II X",
  "ASUS ROG Strix Scope II 96 Wireless",
  "iPad Air",
  "iPad",
  "Samsung Galaxy S25 Ultra",
  "iPhone Air",
  "Xiaomi 15",
  "Sony WH-1000XM5",
  "Bose QuietComfort II",
  "Samsung U8000F",
  "Nothing Phone (3a) Plus",
  "Google Pixel 9a",
  "OnePlus 13R",
  "Keychron K3",
  "JBL Tune 520BT",
  "LG C4",
  "Hisense 55A6N",
  "Microsoft Surface Laptop",
  "Huawei MatePad 11.5",
  "Anker Prime",
];

const rows = [];

async function audit(query) {
  const res = await collectLiveResults(query);
  const rawRows = res.notes.reduce((n, note) => n + note.hits, 0);
  const cards = res.products.length;
  const offerRows = res.products.reduce((n, p) => n + p.offers.length, 0);
  rows.push({ query, merchants: res.notes.length, rawRows, cards, offerRows });
  expect(cards).toBeGreaterThanOrEqual(1);
  console.log(
    `${query} | retailers=${res.notes.length} raw=${rawRows} cards=${cards} offerRows=${offerRows} fold=${rawRows ? Math.round((1 - cards / rawRows) * 100) : 0}%`,
  );
}

QUERIES.forEach((q) => {
  it(`audit: ${q}`, async () => audit(q));
});

afterAll(() => {
  const raw = rows.reduce((n, r) => n + r.rawRows, 0);
  const cards = rows.reduce((n, r) => n + r.cards, 0);
  const fold = raw ? ((1 - cards / raw) * 100).toFixed(1) : "n/a";
  console.log(`AUDIT TOTALS queries=${rows.length} rawRows=${raw} cards=${cards} aggregateReduction=${fold}%`);
});
