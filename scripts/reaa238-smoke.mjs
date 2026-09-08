// REEA-238 evidence smoke: run the real live-query-time collection chain with
// the platform fetch against the five new retailer adapters (+ existing ones).
import { collectLiveResults } from "@/lib/collect/live-search";

const run = async (query) => {
  const t0 = Date.now();
  const { products, notes } = await collectLiveResults(query, { fetchImpl: fetch, country: "KW" });
  console.log(`\nQUERY: ${query}  products=${products.length}  elapsed=${Date.now() - t0}ms`);
  // First live offer per merchant — the per-store evidence the issue asks for.
  const seen = new Map();
  for (const p of products) {
    for (const o of p.offers) {
      if (!seen.has(o.merchant)) seen.set(o.merchant, `${o.price} ${o.currency} | inStock=${o.inStock} | scrapedAt=${o.scrapedAt} | ${o.url} | ${(o.title ?? "").slice(0, 70)}`);
    }
  }
  for (const [m, line] of seen) console.log(`[${m}] ${line}`);
  if (notes?.length) console.log("notes:", JSON.stringify(notes));
};

await run("iPhone 15");
await run("LG washing machine");
