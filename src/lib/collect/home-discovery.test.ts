/**
 * REEA-1070 AC1 — the server runner must keep one failed query from blanking
 * the whole home discovery payload, and must read the shared affiliate
 * disclosure rather than a forked copy.
 */
import { describe, expect, it } from "vitest";
import type { LiveSearchStages } from "@/lib/collect/live-search";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import { collectHomeDiscovery } from "@/lib/collect/home-discovery";
import { getStrings } from "@/lib/i18n";

function stagesOf(final: Promise<LiveSearchResult>): LiveSearchStages {
  return {
    stages: [final],
    final,
    allSettled: Promise.resolve(null),
    converged: final,
    adapterTelemetry: Promise.resolve({ attempts: {}, failures: {} }),
    // REEA-1078 — the collection layer always stamps the serve kind; this
    // fixture stands for a cold run (no fan-out-less memo hit).
    serveKind: "cold",
  };
}

describe("collectHomeDiscovery (REEA-1070 AC1)", () => {
  it("keeps a rejected query as a no-response row without blanking the others", async () => {
    const good: LiveSearchResult = {
      products: [
        {
          productId: "p1",
          title: "Apple iPhone 17 Pro",
          brand: "Apple",
          offers: [
            {
              merchant: "Xcite",
              price: 189.9,
              currency: "KWD",
              url: "https://example.test/p",
              inStock: true,
              wasPrice: 214,
              collectedAt: "2026-11-23T12:00:00.000Z",
              collectedAtEpochMs: Date.parse("2026-11-23T12:00:00Z"),
            },
          ],
          coupons: [],
          variations: [],
          alternatives: [],
        },
      ],
      notes: [{ merchant: "Xcite", hits: 1 }],
      responders: { queried: ["Xcite"], answered: ["Xcite"], answeredEmpty: [], noResponse: [] },
      collectedAt: "2026-11-23T12:00:00.000Z",
      collectedAtEpochMs: Date.parse("2026-11-23T12:00:00Z"),
    };
    const data = await collectHomeDiscovery([
      { query: "iphone", stages: stagesOf(Promise.resolve(good)) },
      { query: "broken", stages: stagesOf(Promise.reject(new Error("boom"))) },
    ]);
    expect(data.status).toBe("live");
    expect(data.partial).toBe(true);
    expect(data.queries.map((q) => q.query)).toEqual(["iphone", "broken"]);
    expect(data.queries[1].responders.queried).toEqual([]);
    expect(data.priceDrops.items[0].savings.baseline.merchant).toBe("Xcite");
  });

  it("uses the shared affiliate disclosure in both locales", async () => {
    const data = await collectHomeDiscovery([]);
    expect(data.methodBand.disclosure).toEqual({
      en: getStrings("en").footerDisclosure,
      ar: getStrings("ar").footerDisclosure,
    });
    expect(data.status).toBe("no-response");
  });
});
