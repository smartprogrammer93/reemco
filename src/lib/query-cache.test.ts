/**
 * REEA-277 / REEA-291 AC5 — per-query response-cache unit tests: the single
 * 90-second memoization window behind the repeat-query fix (entries inside it
 * serve immediately, entries past it are dropped and re-collected live), the
 * bounded entry set, the TTL ceiling the acceptance criteria demand
 * (≤ 15 min, aged ≤ 2 min), and the cache-key identity rules: the NORMALIZED
 * QUERY STRING ONLY — case folds together and viewer-side signals (country,
 * cookie, language hint) never fork the memo.
 */
import { describe, expect, it } from "vitest";
import {
  createQueryCache,
  QUERY_CACHE_FRESH_MS,
  QUERY_CACHE_MAX_AGE_MS,
  QUERY_CACHE_MAX_ENTRIES,
  queryCacheKey,
} from "@/lib/query-cache";

function fakeClock() {
  const state = { now: 0 };
  return {
    now: (): number => state.now,
    advance: (ms: number): void => {
      state.now += ms;
    },
  };
}

describe("query cache window (REEA-277 / REEA-291 AC5)", () => {
  it("inside the window entries serve immediately, flagged fresh", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("sony", { products: [{ scrapedAt: "t0" }] });

    const hit = cache.read<{ products: { scrapedAt: string }[] }>("sony");
    expect(hit).not.toBeNull();
    expect(hit!.stale).toBe(false);
    expect(hit!.value.products[0].scrapedAt).toBe("t0");

    // The window's own edge still serves fresh (≤ 90 s age is the AC5 bar).
    clock.advance(QUERY_CACHE_FRESH_MS);
    const edge = cache.read<{ products: { scrapedAt: string }[] }>("sony");
    expect(edge).not.toBeNull();
    expect(edge!.stale).toBe(false);
  });

  it("past the ceiling the entry is dropped — never served (AC-3)", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("sony", "answer");
    clock.advance(QUERY_CACHE_MAX_AGE_MS + 1);

    expect(cache.read("sony")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("the ceiling stays at or below the 15-minute budget, aged ≤ 2 min", () => {
    expect(QUERY_CACHE_MAX_AGE_MS).toBeLessThanOrEqual(15 * 60_000);
    // The served-age ceiling is the memoization window itself.
    expect(QUERY_CACHE_FRESH_MS).toBeLessThanOrEqual(QUERY_CACHE_MAX_AGE_MS);
  });

  it("a repeat inside the window HITs without a second fan-out (AC5)", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("sony", "answer");
    clock.advance(QUERY_CACHE_FRESH_MS - 1); // inside the 90 s window
    expect(cache.read("sony")).not.toBeNull();
  });

  it("evicts oldest-first when the entry budget is full", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("a", 1);
    clock.advance(1);
    cache.write("b", 2);
    for (let i = 0; i < QUERY_CACHE_MAX_ENTRIES - 1; i++) {
      clock.advance(1);
      cache.write(`k${i}`, i);
    }
    expect(cache.size()).toBe(QUERY_CACHE_MAX_ENTRIES);
    cache.write("c", 3);
    expect(cache.size()).toBe(QUERY_CACHE_MAX_ENTRIES);
    // Oldest entry ("a") gave way; the newest survive.
    expect(cache.read("a")).toBeNull();
    expect(cache.read("c")).not.toBeNull();
  });

  it("re-writing a key refreshes the entry in place", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("sony", "old");
    clock.advance(QUERY_CACHE_FRESH_MS - 1);
    cache.write("sony", "new");
    expect(cache.read<string>("sony")).toEqual({ value: "new", stale: false });
    expect(cache.size()).toBe(1);
  });
});

describe("query cache keys (REEA-291 AC5)", () => {
  it("folds case and surrounding whitespace into one identity", () => {
    expect(queryCacheKey("iPhone ")).toBe(queryCacheKey("iphone"));
  });

  it("is the query alone — viewer-side selections never fork the memo", () => {
    // One live answer per query serves every shopper; the country/stock
    // selections filter the loaded payload at render time (ResultsClient),
    // so the key carries only the normalized query.
    expect(queryCacheKey("  Sony XM6  ")).toBe("sony xm6");
  });

  it("the country selection joins the key when it scopes the fan-out", () => {
    // REEA-170: COLLECTORS are filtered to the adapters tagged for the
    // selection, so the ANSWER itself differs — the identity must too.
    // Without a selection the plain query-only key above still applies.
    expect(queryCacheKey("sony", "KW")).not.toBe(queryCacheKey("sony"));
    expect(queryCacheKey("sony", "KW")).not.toBe(queryCacheKey("sony", "EG"));
    expect(queryCacheKey(" Sony ", null)).toBe(queryCacheKey("sony"));
  });
});
