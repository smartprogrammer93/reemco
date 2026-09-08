/**
 * REEA-277 — per-query response-cache unit tests: the fresh/stale/max-age
 * windows behind stale-while-revalidate, the bounded entry set, the TTL
 * ceiling the acceptance criteria demand (≤ 15 min), and the cache-key
 * identity rules (case folding + per-country views).
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

describe("query cache windows (REEA-277)", () => {
  it("fresh entries serve without a revalidation flag", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("kw|sony", { products: [{ scrapedAt: "t0" }] });

    const hit = cache.read<{ products: { scrapedAt: string }[] }>("kw|sony");
    expect(hit).not.toBeNull();
    expect(hit!.stale).toBe(false);
    expect(hit!.value.products[0].scrapedAt).toBe("t0");

    clock.advance(QUERY_CACHE_FRESH_MS);
    expect(cache.read("kw|sony")!.stale).toBe(false);
  });

  it("inside the stale window the entry still serves AND asks for revalidation (SWR)", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("kw|sony", "last-live-answer");
    clock.advance(QUERY_CACHE_FRESH_MS + 1);

    const hit = cache.read<string>("kw|sony");
    expect(hit).not.toBeNull();
    expect(hit!.value).toBe("last-live-answer");
    expect(hit!.stale).toBe(true);
  });

  it("past the ceiling the entry is dropped — never served (AC-3)", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("kw|sony", "answer");
    clock.advance(QUERY_CACHE_MAX_AGE_MS + 1);

    expect(cache.read("kw|sony")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("the ceiling stays at or below the 15-minute AC-3 budget", () => {
    expect(QUERY_CACHE_MAX_AGE_MS).toBeLessThanOrEqual(15 * 60_000);
    expect(QUERY_CACHE_FRESH_MS).toBeLessThan(QUERY_CACHE_MAX_AGE_MS);
  });

  it("repeats inside a 5-minute horizon always HIT (AC-2)", () => {
    const clock = fakeClock();
    const cache = createQueryCache(clock.now);
    cache.write("kw|sony", "answer");
    clock.advance(5 * 60_000); // the AC-2 repeat horizon
    expect(cache.read("kw|sony")).not.toBeNull();
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
    cache.write("kw|sony", "old");
    clock.advance(QUERY_CACHE_FRESH_MS + 1);
    cache.write("kw|sony", "new");
    expect(cache.read<string>("kw|sony")).toEqual({ value: "new", stale: false });
    expect(cache.size()).toBe(1);
  });
});

describe("query cache keys (REEA-277)", () => {
  it("folds case and surrounding whitespace into one identity", () => {
    expect(queryCacheKey("iPhone ", null)).toBe(queryCacheKey("iphone", null));
  });

  it("keeps country-scoped views separate (different adapter sets answer)", () => {
    expect(queryCacheKey("sony", "KW")).not.toBe(queryCacheKey("sony", null));
    expect(queryCacheKey("sony", "KW")).not.toBe(queryCacheKey("sony", "EG"));
  });
});
