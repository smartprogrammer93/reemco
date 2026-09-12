/**
 * REEA-743 — the exact-SKU head guard on STORED snapshots. The fresh fan-out
 * narrows inside rankByRelevance, but the three stored-snapshot lanes (fresh
 * memo hit, stale cache-first flush, REEA-602 shared-warm KV replay) serve
 * whatever the writing chain left behind — including aged filler-led heads
 * from before the narrowing. narrowSkuLead re-heads such snapshots at serve
 * time; these pins cover the guard itself and all three lanes end-to-end.
 */
import "./test-cache-dir";
import { describe, expect, it, vi } from "vitest";
import { createQueryCache, queryCacheKey } from "@/lib/query-cache";
import { collectLiveResultsStaged, resetDiscoveryCache } from "@/lib/collect/live-search";
import { mirrorSharedQuerySnapshot, replaySharedQuerySnapshot } from "@/lib/collect/query-layer";
import { narrowSkuLead } from "@/lib/relevance";
import type { NormalizedProduct } from "@/types/product";

process.env.KV_REST_API_URL = "https://kv.example.test/";
process.env.KV_REST_API_TOKEN = "test-token";

function product(productId: string, title: string): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers: [{ merchant: "Xcite", price: 5, currency: "KWD", url: "https://xcite.com/p", inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

const MATCHER = product("m1", "EF-PS931CBEGWW – Black");
const FILLER_A = product("f1", "Universal Silicone Case");
const FILLER_B = product("f2", "Screen Protector Film");
const SKU_Q = "EF PS931CBEGWW";

describe("narrowSkuLead — the serve-time guard", () => {
  it("leads code-bearing rows and keeps stored order inside each side", () => {
    const stored = [FILLER_A, MATCHER, FILLER_B];
    expect(narrowSkuLead(SKU_Q, stored).map((p) => p.productId)).toEqual(["m1", "f1", "f2"]);
  });

  it("is idempotent — a memo hit of an already-narrowed snapshot cannot drift", () => {
    const once = narrowSkuLead(SKU_Q, [FILLER_A, MATCHER, FILLER_B]);
    expect(narrowSkuLead(SKU_Q, once).map((p) => p.productId)).toEqual(once.map((p) => p.productId));
  });

  it("folds the hyphen/space spellings — spaced query meets the hyphenated storefront title", () => {
    const titles = narrowSkuLead(SKU_Q, [FILLER_A, MATCHER]).map((p) => p.title);
    expect(titles[0]).toBe("EF-PS931CBEGWW – Black");
    // …and the other direction: the hyphenated query meets a spaced title.
    const spaced = product("s1", "EF PS931CBEGWW Black");
    expect(narrowSkuLead("EF-PS931CBEGWW", [FILLER_A, spaced])[0].productId).toBe("s1");
  });

  it("leaves the stored order standing when no row carries the code — an honest zero is not re-ranked", () => {
    const stored = [FILLER_A, FILLER_B];
    expect(narrowSkuLead(SKU_Q, stored).map((p) => p.productId)).toEqual(["f1", "f2"]);
  });

  it("passes non-SKU queries through untouched — family-first pins keep their served order", () => {
    const phone = product("p1", "Apple iPhone 17 Pro 256GB");
    const phoneCase = product("pc1", "Apple iPhone 17 Pro Silicone Case");
    // Family-first is decided inside rankByRelevance at fresh-run time; the
    // serve-time guard must not re-head the stored result.
    expect(narrowSkuLead("iPhone 17 Pro", [phone, phoneCase]).map((p) => p.productId)).toEqual(["p1", "pc1"]);
    const galaxy = product("g1", "Samsung Galaxy S25 128GB");
    const galaxyCase = product("gc1", "Samsung Galaxy S25 Silicone Case");
    expect(narrowSkuLead("samsung galaxy s25", [galaxy, galaxyCase]).map((p) => p.productId)).toEqual(["g1", "gc1"]);
    // One descriptive word next to the code turns the plain ladder back on.
    expect(narrowSkuLead("black EF PS931CBEGWW", [FILLER_A, MATCHER]).map((p) => p.productId)).toEqual(["f1", "m1"]);
  });

  it("serves the identical order for the Arabic-script twin of the same query", () => {
    const en = narrowSkuLead(SKU_Q, [FILLER_A, MATCHER]).map((p) => p.productId);
    const ar = narrowSkuLead(`${SKU_Q} أسود`, [FILLER_A, MATCHER]).map((p) => p.productId);
    expect(ar).toEqual(en);
  });
});

describe("stored-snapshot lanes re-head at serve time", () => {
  it("fresh memo hit: an aged filler-led snapshot leads with the matcher", async () => {
    resetDiscoveryCache();
    const cache = createQueryCache();
    cache.write(queryCacheKey(SKU_Q), { products: [FILLER_A, MATCHER], notes: [] });
    const run = collectLiveResultsStaged(SKU_Q, { cache, fetchImpl: async () => new Response("{}") });
    const snap = await run.final;
    expect(snap.products[0].title).toBe("EF-PS931CBEGWW – Black");
  });

  it("stale cache-first flush: the first flush is re-headed while the run's own hops answer behind it", async () => {
    resetDiscoveryCache();
    let clock = 0;
    const cache = createQueryCache(() => clock);
    cache.write(queryCacheKey(SKU_Q), { products: [FILLER_A, MATCHER], notes: [] });
    clock = 90_000; // past the fresh window, inside the ceiling: SWR path
    const run = collectLiveResultsStaged(SKU_Q, { cache, fetchImpl: async () => jsonResponse({}), deadlineMs: 500 });
    const firstFlush = await run.stages[0];
    expect(firstFlush.products[0].title).toBe("EF-PS931CBEGWW – Black");
    await run.allSettled; // the behind-response chain still closes normally
  });

  it("shared-warm KV replay: the replayed aged snapshot leads with the matcher", async () => {
    resetDiscoveryCache();
    // Shared-backend emulation, same shape as reea602-shared-warm.test.
    const table = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === "kv.example.test") {
          const [, command, rawKey] = url.pathname.split("/");
          const key = decodeURIComponent(rawKey ?? "");
          if (command === "get") {
            return new Response(JSON.stringify({ result: table.get(key) ?? null, ok: true }));
          }
          const [value] = String(init?.body ?? "").split("\n");
          table.set(key, value);
          return new Response(JSON.stringify({ ok: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        return jsonResponse({});
      }),
    );
    // Seed the layer with an aged filler-led snapshot (pre-narrowing shape).
    await mirrorSharedQuerySnapshot(queryCacheKey(SKU_Q), { products: [FILLER_A, MATCHER], notes: [] });
    expect(await replaySharedQuerySnapshot(queryCacheKey(SKU_Q))).toBeTruthy();

    const run = collectLiveResultsStaged(SKU_Q, {
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return jsonResponse({});
      },
      cache: createQueryCache(),
      snapshots: true,
      deadlineMs: 2000,
    });
    const lead = await run.stages[0];
    expect(lead.products[0].title).toBe("EF-PS931CBEGWW – Black");
    await run.allSettled;
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
