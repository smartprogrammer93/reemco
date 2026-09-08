/** REEA-316 headline evidence: one live run of the two brief queries,
 *  printing the merged card's row list exactly as ResultsClient renders it. */
import { expect, it } from "vitest";
import { collectLiveResults } from "../src/lib/collect/live-search.ts";

const dump = async (query) => {
  const res = await collectLiveResults(query);
  console.log(`\nQUERY: ${query} — ${res.products.length} cards`);
  res.products.slice(0, 4).forEach((p, i) => {
    console.log(`#${i + 1} ${p.title}`);
    p.offers.forEach((o) => console.log(`   ${o.merchant} ${o.price} ${o.currency}${o.wasPrice ? ` (was ${o.wasPrice})` : ""}`));
  });
  expect(res.products.length).toBeGreaterThanOrEqual(1);
};

it("headline: ASUS ROG Strix Scope II X", async () => dump("ASUS ROG Strix Scope II X"));
it("headline guardrail: ASUS ROG Strix Scope II 96 Wireless", async () => dump("ASUS ROG Strix Scope II 96 Wireless"));
