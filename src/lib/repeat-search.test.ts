/**
 * REEA-439 — bounded-staleness repeat-search regression tests:
 * the shared edge window (set from the proxy layer) must stay in the 30–60 s
 * band with a stale tail that keeps the worst served age ≈60 s, must not be
 * `no-store` (that is the bug this issue fixes), and must cover both results
 * addresses while leaving other routes alone; the server-side memo window
 * stays inside the same band; and the Refresh bypass always produces a UNIQUE
 * URL (guaranteed miss on the shared entry) without disturbing the
 * normalized-query identity the memo keys on.
 */
import { describe, expect, it } from "vitest";
import { RESULTS_CACHE_CONTROL, proxy } from "../proxy";
import {
  QUERY_CACHE_FRESH_MS,
  createQueryCache,
  queryCacheKey,
  withRefreshBypass,
} from "@/lib/query-cache";

function makeRequest(pathname: string) {
  return { nextUrl: { pathname }, headers: new Headers() } as Parameters<typeof proxy>[0];
}

describe("REEA-439 shared repeat-search window (proxy headers)", () => {
  it("sets a bounded shared window in the 30–60 s band", () => {
    const cc = RESULTS_CACHE_CONTROL;
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=0");
    expect(cc).not.toContain("no-store");
    const smatch = cc.match(/s-maxage=(\d+)/);
    const swrMatch = cc.match(/stale-while-revalidate=(\d+)/);
    expect(smatch).not.toBeNull();
    expect(swrMatch).not.toBeNull();
    const fresh = Number(smatch![1]);
    const swr = Number(swrMatch![1]);
    // Issue: the window is about a minute (30–60 s band).
    expect(fresh).toBeGreaterThanOrEqual(30);
    expect(fresh).toBeLessThanOrEqual(60);
    // AC-3: worst served age ≈ 60 s plus one fetch cycle.
    expect(fresh + swr).toBeLessThanOrEqual(60);
  });

  it("applies the window + locale vary on both results addresses", () => {
    for (const pathname of ["/results", "/search"]) {
      const res = proxy(makeRequest(pathname));
      expect(res.headers.get("Cache-Control")).toBe(RESULTS_CACHE_CONTROL);
      expect(res.headers.get("Vary")).toContain("Accept-Language");
    }
  });

  it("leaves non-results routes to the framework defaults", () => {
    const res = proxy(makeRequest("/about"));
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("memo fresh window stays inside the same bounded band", () => {
    expect(QUERY_CACHE_FRESH_MS).toBeGreaterThanOrEqual(30_000);
    expect(QUERY_CACHE_FRESH_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("REEA-439 repeat answers warm with the same stamp", () => {
  it("a repeat inside the window serves the SAME live answer (same scrapedAt)", () => {
    let nowMs = 0;
    const cache = createQueryCache(() => nowMs);
    cache.write(queryCacheKey("Sony XM6 "), { scrapedAt: "t-live", products: [1] });
    nowMs = QUERY_CACHE_FRESH_MS - 1;
    const hit = cache.read<{ scrapedAt: string }>(queryCacheKey("sony xm6"));
    expect(hit).not.toBeNull();
    expect(hit!.stale).toBe(false);
    expect(hit!.value.scrapedAt).toBe("t-live");
  });
});

describe("REEA-439 Refresh bypass URL", () => {
  it("is unique per click and keeps every other param", () => {
    const a = withRefreshBypass("/results?q=sony%20xm5&c=KW&oos=1&page=2", 1000);
    const b = withRefreshBypass("/results?q=sony%20xm5&c=KW&oos=1&page=2", 2000);
    expect(a).not.toBe(b);
    expect(a).toBe("/results?q=sony+xm5&c=KW&oos=1&page=2&_r=1000");
  });

  it("replaces a previous bypass stamp instead of stacking them", () => {
    const once = withRefreshBypass("/results?q=sony&_r=1000", 2000);
    expect(once.match(/_r=/g)).toHaveLength(1);
    expect(once).toBe("/results?q=sony&_r=2000");
  });

  it("works on a bare /results and keeps a hash fragment", () => {
    expect(withRefreshBypass("/results", 7)).toBe("/results?_r=7");
    expect(withRefreshBypass("/results?q=sony#top", 7)).toBe("/results?q=sony&_r=7#top");
  });

  it("does not fork the memo identity — normalized query key unchanged", () => {
    const busted = withRefreshBypass("/results?q=Sony%20XM6%20", 42);
    const params = new URLSearchParams(busted.slice(busted.indexOf("?") + 1));
    expect(queryCacheKey(params.get("q")!)).toBe(queryCacheKey(" Sony XM6 "));
  });
});
