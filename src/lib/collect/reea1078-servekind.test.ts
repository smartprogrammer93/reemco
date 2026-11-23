/**
 * REEA-1078 AC-3 — the serve-kind split must actually separate a repeat
 * shopper's serve from a cold collection. On the self-hosted box the
 * completion budget closes before the slowest hops land, so the memo write is
 * STALE almost every time and a repeat takes the stale-while-revalidate path:
 * the cached live answer leads the paint, the fan-out deepens behind it. If
 * that repeat were folded into the cold 3–10 s band, every serve would read as
 * "3–10 s" and the counter could still not answer "what does a repeat shopper
 * experience" — the REEA-1074 F4 defect this AC names.
 */
import { describe, expect, it } from "vitest";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { createQueryCache, queryCacheKey } from "@/lib/query-cache";
import type { LiveSearchResult } from "@/lib/collect/coverage";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

const fetchImpl = (async (url: string) => {
  if (String(url).includes("xcite.com")) {
    return jsonResponse({
      results: [
        {
          hits: [
            {
              name: "Sony WH-1000XM6",
              slug: "wh1000xm6",
              price: 149.9,
              currency: "KWD",
              inStock: true,
            },
          ],
        },
      ],
    });
  }
  return jsonResponse({});
}) as unknown as typeof fetch;

const cachedSnapshot: LiveSearchResult = {
  products: [
    {
      productId: "sony-wh-1000xm6",
      title: "Sony WH-1000XM6",
      brand: "Sony",
      offers: [
        {
          merchant: "Xcite",
          price: 149.9,
          currency: "KWD",
          url: "https://www.xcite.com/p/1",
          inStock: true,
        },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: "2026-11-23T05:00:00.000Z",
    },
  ],
  notes: [{ merchant: "Xcite", hits: 1, coupons: 0 }],
};

describe("serve kind (REEA-1078 AC-3)", () => {
  it("stamps a stale-while-revalidate repeat as a warm serve, not a cold one", async () => {
    const cache = createQueryCache();
    cache.write(queryCacheKey("xm6"), cachedSnapshot, { stale: true });
    const staged = collectLiveResultsStaged("xm6", {
      fetchImpl,
      cache,
      deadlineMs: 40,
      country: "KW",
    });
    expect(staged.serveKind).toBe("warm");
    // The cached live answer is the FIRST stage — the shopper's first paint.
    expect(staged.stages.length).toBeGreaterThan(1);
    expect((await staged.stages[0]).products).toHaveLength(1);
  });

  it("stamps a fresh memo hit as warm and runs no fan-out", async () => {
    const cache = createQueryCache();
    cache.write(queryCacheKey("xm6"), cachedSnapshot);
    const staged = collectLiveResultsStaged("xm6", { fetchImpl, cache, country: "KW" });
    expect(staged.serveKind).toBe("warm");
    expect(await staged.adapterTelemetry).toEqual({ attempts: {}, failures: {} });
  });

  it("keeps a genuine cold collection cold", async () => {
    const staged = collectLiveResultsStaged("xm6", {
      fetchImpl,
      cache: createQueryCache(),
      deadlineMs: 40,
      country: "KW",
    });
    expect(staged.serveKind).toBe("cold");
    const telemetry = await staged.adapterTelemetry;
    expect(Object.keys(telemetry.attempts).length).toBeGreaterThan(0);
  });
});
