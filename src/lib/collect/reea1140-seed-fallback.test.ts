/**
 * REEA-1140 — a detail-page re-check must not drop a live query-time offer.
 *
 * Live QA (REEA-1118) measured the PDP starting the same merged group but
 * ending with one retailer: Blink answered HTTP 429, Wibi/Astore's title
 * search found nothing, and only Eureka's fallback row survived. The card had
 * already fetched those listings live at query time; a failed re-check must
 * replay that exact listing (same merchant, price and URL) instead of blanking
 * the retailer. Catalog seeds (no collection stamp) keep the REEA-67 search
 * rediscovery.
 */
import { describe, expect, it } from "vitest";
import { scrapeOffer } from "@/lib/collect/scraper";

const SEED = {
  merchant: "Blink",
  url: "https://blink.com.kw/products/sony-ps5-dualsense-wireless-controller-1",
  currency: "KWD",
  price: 25.9,
  inStock: true,
  collectedAt: "2026-11-24T12:00:00.000Z",
  titleQuery: "Sony PS5 DualSense Wireless Controller",
};

describe("REEA-1140 — failed listing re-check falls back to the live row", () => {
  it("keeps the exact query-time listing when the retailer fetch errors", async () => {
    const out = await scrapeOffer(SEED, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.offers).toHaveLength(1);
    expect(out.offers[0]).toMatchObject({
      merchant: "Blink",
      price: 25.9,
      currency: "KWD",
      url: SEED.url,
      inStock: true,
      collectedAt: SEED.collectedAt,
    });
  });

  it("keeps the live row when the retailer answers 429", async () => {
    const out = await scrapeOffer(SEED, {
      fetchImpl: async () => new Response("", { status: 429 }),
    });
    expect(out.offers).toHaveLength(1);
    expect(out.offers[0].price).toBe(25.9);
    expect(out.offers[0].url).toBe(SEED.url);
  });

  it("still reads the real listing price when the page is parseable", async () => {
    const html =
      '<html><head><meta property="product:price:amount" content="24.500">' +
      '<meta property="product:price:currency" content="KWD"></head></html>';
    const out = await scrapeOffer(SEED, {
      fetchImpl: async () => new Response(html, { status: 200 }),
    });
    expect(out.offers).toHaveLength(1);
    // The live page wins over the query-time row when it is readable.
    expect(out.offers[0].price).toBe(24.5);
  });

  it("does not replay a catalog seed that has no collection stamp", async () => {
    const catalog = { ...SEED, price: undefined, collectedAt: undefined };
    const out = await scrapeOffer(catalog, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    // No live row to replay: the failure surfaces honestly.
    expect(out.offers).toHaveLength(0);
    expect(out.error).toBeTruthy();
  });
});
