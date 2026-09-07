/**
 * REEA-149 — the REEA-134 per-query table method against the live code path.
 * One row per query: the query string, the distinct merchants whose offers
 * actually rendered, whether >=1 offer appeared, and the products' scrapedAt
 * age (AC4: within 24 h confirms query-time fetch). Hits the real retailer
 * endpoints, so run it with network access:
 *
 *   npx vitest run src/lib/collect/reea149-probe.test.ts
 */
import { describe, expect, it } from "vitest";
import { collectLiveResults } from "@/lib/collect/live-search";

// The brief's six queries (§1) plus the REEA-141 samsung row as regression (AC6).
const QUERIES = [
  "WH-1000XM6",
  "AirPods Pro",
  "JBL Tune 520BT",
  "lg gram",
  "MacBook Air",
  "Lenovo IdeaPad Slim 3",
  "samsung",
];

describe("REEA-149 per-query table (live)", () => {
  for (const q of QUERIES) {
    it(`row: ${q}`, async () => {
      const res = await collectLiveResults(q);
      const merchants = new Set<string>();
      for (const p of res.products) for (const o of p.offers) merchants.add(o.merchant);
      const ages = res.products.map((p) => Date.now() - Date.parse(p.scrapedAt ?? ""));
      console.log(
        `ROW | ${q} | ${[...merchants].join(", ")} | offers>=1: ${res.products.length > 0} | ` +
          `maxAgeH: ${ages.length ? (Math.max(...ages) / 3_600_000).toFixed(4) : "n/a"} | notes: ${JSON.stringify(res.notes)}`,
      );
      expect(res.products.length).toBeGreaterThan(0);
    }, 30_000);
  }
});
