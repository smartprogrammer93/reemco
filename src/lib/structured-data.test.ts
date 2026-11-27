/**
 * REEA-1168 / REEA-1212 — Product/Offer structured-data guardrails.
 *
 * The defect this file pins: the JSON-LD used to read the raw offer array
 * through its own filter, while the results card painted the market-scoped,
 * coupon-composed, folded, 3-row offer set. On `/results?q=iphone 17 pro` the
 * page said "You pay KD 314.90" (Wibi) while the JSON-LD advertised KD 319.90
 * and had no Wibi offer at all. These tests derive the expected Offer set from
 * the SAME visible-offer projection the card uses, so a future divergence
 * fails here instead of on the live page.
 */
import { describe, expect, it } from "vitest";
import {
  STRUCTURED_DATA_FRESHNESS_MS,
  buildProductStructuredData,
  buildResultsStructuredData,
  serializeJsonLd,
  type StructuredDataSnapshot,
} from "@/lib/structured-data";
import { visibleShelfOffers } from "@/lib/results-offers";
import type { LiveOffer } from "@/lib/collect/types";
import type { Coupon, NormalizedProduct, PriceOffer } from "@/types/product";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const ORIGIN = "https://ns539626.ip-144-217-72.net";
const QUERY = "iPhone 17 Pro";

function offer(overrides: Partial<PriceOffer>): PriceOffer {
  return {
    merchant: "Xcite",
    price: 399.9,
    currency: "KWD",
    url: "https://www.xcite.com/iphone-17-pro/p",
    inStock: true,
    ...overrides,
  };
}

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    productId: "iphone-17-pro",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
    ...overrides,
  };
}

function snapshot(products: NormalizedProduct[]): StructuredDataSnapshot {
  return { products };
}

function build(
  products: NormalizedProduct[],
  opts: { locale?: "en" | "ar"; country?: "KW" | "SA" | "EG" | null; page?: number } = {},
) {
  return buildResultsStructuredData({
    snapshot: snapshot(products),
    query: QUERY,
    country: opts.country ?? null,
    locale: opts.locale ?? "en",
    nowMs: NOW,
    origin: ORIGIN,
    page: opts.page ?? 1,
  });
}


const FRESH = new Date(NOW - 5 * 60 * 1000).toISOString();

describe("REEA-1212 — JSON-LD describes the card's visible offer set", () => {
  it("emits the coupon-effective visible best offer (Wibi KD 314.90), not the listed Xcite price", () => {
    // The live shape from the defect: Wibi is the card headline at KD 314.90
    // after its KD 50.10 coupon; Xcite 319.90 and two identical Eureka 331.90
    // rows are behind it.
    const wibiCoupon: Coupon = {
      code: "WIBI50",
      description: "KD 50.10 off",
      discount: "KD 50.10 off",
      expiresAt: null,
      merchant: "Wibi",
    };
    const p = product({
      productId: "apple-iphone17-pro-256gb",
      title: "Apple iPhone 17 Pro 256Gb Silver",
      offers: [
        offer({
          merchant: "Wibi",
          price: 365,
          url: "https://www.wibi.com.kw/iphone-17-pro",
          collectedAt: FRESH,
          // The live record the Frontend lane measured: a last-seen replay
          // with a fresh observation stamp. It is painted as the headline, so
          // it must reach JSON-LD (the old eligibleOffers() dropped it).
          fromSnapshot: true,
        }),
        offer({
          merchant: "Xcite",
          price: 319.9,
          url: "https://www.xcite.com/iphone-17-pro",
          collectedAt: FRESH,
        }),
        offer({
          merchant: "Eureka",
          price: 331.9,
          url: "https://www.eureka.com.kw/iphone-17-pro-a",
          collectedAt: FRESH,
        }),
        offer({
          merchant: "Eureka",
          price: 331.9,
          url: "https://www.eureka.com.kw/iphone-17-pro-b",
          collectedAt: FRESH,
        }),
      ],
      coupons: [wibiCoupon],
    });

    const nodes = build([p], { country: "KW" });
    expect(nodes).toHaveLength(1);
    const node = nodes[0];

    // The visible projection is the source of truth for both sides.
    const visible = visibleShelfOffers(p, "KW");
    expect(visible.best?.merchant).toBe("Wibi");
    expect(visible.best?.priceComposition?.effective).toBe(314.9);

    // The emitted Offer set is exactly the painted rows (the two identical
    // Eureka rows fold to one), and the headline offer is present. REEA-1238 —
    // the card paints `cardRows` (headline first, one row per retailer), so
    // the JSON-LD describes that same set.
    expect(node.offers).toHaveLength(visible.cardRows.length);
    expect(node.offers.map((o) => o.seller.name)).toEqual(
      visible.cardRows.map((o) => o.merchant),
    );
    const wibi = node.offers.find((o) => o.seller.name === "Wibi");
    expect(wibi).toBeDefined();
    expect(wibi?.price).toBe(314.9);
    expect(wibi?.priceCurrency).toBe("KWD");
    // The duplicate Eureka listing is one visible row, so one Offer.
    expect(node.offers.filter((o) => o.seller.name === "Eureka")).toHaveLength(1);

    // "starting at" is the page's visible best price, not a second claim.
    expect(node.description).toContain("3 retailer offers, starting at 314.9 KWD");
    // No emitted Offer may be absent from the painted rows.
    const visibleUrls = new Set(visible.rows.map((o) => o.url));
    for (const emitted of node.offers) {
      expect(visibleUrls.has(emitted.url)).toBe(true);
    }
    // The visible best offer is never absent from JSON-LD.
    expect(visibleUrls.has(wibi?.url as string)).toBe(true);
  });

  it("uses the painted card set, not the richer final snapshot, when both are supplied", () => {
    // The page paints one card; the final snapshot carries a second product.
    // The structured data must describe only what the shopper sees.
    const painted = product({
      productId: "apple-iphone17-pro-256gb",
      title: "Apple iPhone 17 Pro 256Gb Silver",
      offers: [offer({ merchant: "Wibi", price: 314.9, collectedAt: FRESH })],
    });
    const extra = product({
      productId: "apple-iphone17-pro-512gb",
      title: "Apple iPhone 17 Pro 512GB",
      offers: [offer({ merchant: "Xcite", price: 449.9, collectedAt: FRESH })],
    });
    const nodes = buildResultsStructuredData({
      cards: [painted],
      snapshot: snapshot([painted, extra]),
      query: QUERY,
      country: "KW",
      locale: "en",
      nowMs: NOW,
      origin: ORIGIN,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].sku).toBe("apple-iphone17-pro-256gb");
    expect(nodes[0].offers.map((o) => o.seller.name)).toEqual(["Wibi"]);
  });

  it("emits a stale-but-visible offer so the starting price still matches the page", () => {
    const staleAt = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const p = product({
      offers: [offer({ merchant: "Wibi", price: 314.9, collectedAt: staleAt })],
    });
    const nodes = build([p], { country: "KW" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].offers).toHaveLength(1);
    expect(nodes[0].offers[0].price).toBe(314.9);
    expect(nodes[0].offers[0].validFrom).toBe(staleAt);
    // The validity window is still derived from the observation stamp; it can
    // be in the past for a row the page itself labels "Stale".
    expect(nodes[0].offers[0].priceValidUntil).toBe(
      new Date(Date.parse(staleAt) + STRUCTURED_DATA_FRESHNESS_MS).toISOString().slice(0, 10),
    );
    expect(nodes[0].description).toContain("starting at 314.9 KWD");
  });

  it("emits a visible offer without inventing a validity window when it has no stamp", () => {
    const p = product({ offers: [offer({ merchant: "Wibi", price: 199 })] });
    const nodes = build([p], { country: "KW" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].offers).toHaveLength(1);
    expect(nodes[0].offers[0].price).toBe(199);
    expect("validFrom" in nodes[0].offers[0]).toBe(false);
    expect("priceValidUntil" in nodes[0].offers[0]).toBe(false);
    expect(nodes[0].description).toContain("starting at 199 KWD");
  });

  it("never emits a cross-market offer the Kuwait card does not paint", () => {
    // REEA-1142: a Kuwait card with a local offer renders only that market's
    // rows; the Saudi listing is not on the card, so it cannot be in JSON-LD.
    const p = product({
      offers: [
        offer({ merchant: "Xcite", price: 319.9, collectedAt: FRESH }),
        offer({
          merchant: "Danube",
          price: 5.8,
          currency: "SAR",
          url: "https://www.danube.sa/iphone-17-pro",
          collectedAt: FRESH,
        }),
      ],
    });
    const nodes = build([p], { country: "KW" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].offers).toHaveLength(1);
    expect(nodes[0].offers[0].seller.name).toBe("Xcite");
    expect(nodes[0].offers[0].priceCurrency).toBe("KWD");
  });

  it("emits the disclosed cross-market fallback when the card has no local offer", () => {
    const p = product({
      offers: [
        offer({
          merchant: "Danube",
          price: 5.8,
          currency: "SAR",
          url: "https://www.danube.sa/iphone-17-pro",
          collectedAt: FRESH,
        }),
      ],
    });
    const nodes = build([p], { country: "KW" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].offers).toHaveLength(1);
    expect(nodes[0].offers[0].priceCurrency).toBe("SAR");
    expect(nodes[0].offers[0].price).toBe(5.8);
    // The card's big headline for a foreign-only card is the native figure.
    expect(nodes[0].description).toContain("starting at 5.8 SAR");
  });

  it("keeps the emitted set within the painted rows and includes a headline beyond the row cap", () => {
    // Three visible rows are low outliers (not comparable evidence), so the
    // card's headline is the fourth offer. The JSON-LD must still carry the
    // headline price, and every other Offer is a painted row.
    const p = product({
      offers: [
        offer({ merchant: "Blink", price: 10, url: "https://blink.example/a", collectedAt: FRESH, sanity: { status: "flagged", reason: "outlier_low", ratioToMedian: 0.05 } }),
        offer({ merchant: "Jarir", price: 11, url: "https://jarir.example/a", collectedAt: FRESH, sanity: { status: "flagged", reason: "outlier_low", ratioToMedian: 0.06 } }),
        offer({ merchant: "Eureka", price: 12, url: "https://eureka.example/a", collectedAt: FRESH, sanity: { status: "flagged", reason: "outlier_low", ratioToMedian: 0.07 } }),
        offer({ merchant: "Xcite", price: 100, url: "https://xcite.example/a", collectedAt: FRESH }),
      ],
    });
    const nodes = build([p], { country: "KW" });
    expect(nodes).toHaveLength(1);
    const visible = visibleShelfOffers(p, "KW");
    expect(visible.rows).toHaveLength(3);
    expect(visible.best?.merchant).toBe("Xcite");
    // The headline offer is present even though its row is behind "view all".
    expect(nodes[0].offers.some((o) => o.seller.name === "Xcite" && o.price === 100)).toBe(true);
    expect(nodes[0].description).toContain("starting at 100 KWD");
    // Every emitted Offer is either a painted row or that visible headline.
    const visibleUrls = new Set([
      ...visible.rows.map((o) => o.url),
      visible.best?.url as string,
    ]);
    for (const emitted of nodes[0].offers) {
      expect(visibleUrls.has(emitted.url)).toBe(true);
    }
  });

  it("emits the same coupon-effective starting price in Arabic", () => {
    const wibiCoupon: Coupon = {
      code: "WIBI50",
      description: "KD 50.10 off",
      discount: "KD 50.10 off",
      expiresAt: null,
      merchant: "Wibi",
    };
    const p = product({
      offers: [
        offer({ merchant: "Wibi", price: 365, url: "https://www.wibi.com.kw/p", collectedAt: FRESH }),
        offer({ merchant: "Xcite", price: 319.9, collectedAt: FRESH }),
      ],
      coupons: [wibiCoupon],
    });
    const nodes = build([p], { country: "KW", locale: "ar" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toContain("أسعار");
    expect(nodes[0].description).toContain("314.9");
    expect(nodes[0].offers.find((o) => o.seller.name === "Wibi")?.price).toBe(314.9);
  });

  it("advertises the sitemap's catalog URL when a live SKU is catalog-covered", () => {
    const nodes = build([
      product({
        productId: "apple-iphone17-pro-256gb",
        title: "Apple iPhone 17 Pro 256Gb Silver",
        offers: [offer({ collectedAt: FRESH, price: 399.9 })],
      }),
    ]);
    expect(nodes).toHaveLength(1);
    // The merge slug is still the SKU; the URL consolidates on the catalog id
    // the sitemap lists, so one product never advertises two addresses.
    expect(nodes[0].sku).toBe("apple-iphone17-pro-256gb");
    expect(nodes[0].url).toBe(`${ORIGIN}/product/iphone-17-pro`);
  });

  it("keeps the merge slug for a live-only SKU the catalog does not cover", () => {
    const nodes = build([
      product({
        productId: "apple-iphone17-pro-512gb",
        title: "Apple iPhone 17 Pro 512GB",
        offers: [offer({ collectedAt: FRESH, price: 449.9 })],
      }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].url).toBe(`${ORIGIN}/product/apple-iphone17-pro-512gb`);
  });

  it("describes the same page slice the shelf renders (page 2 is empty for one card)", () => {
    const p = product({ offers: [offer({ collectedAt: FRESH })] });
    const pageTwo = buildResultsStructuredData({
      snapshot: snapshot([p]),
      query: QUERY,
      country: null,
      locale: "en",
      nowMs: NOW,
      origin: ORIGIN,
      page: 2,
    });
    expect(pageTwo).toEqual([]);
  });

  it("escapes < in serialized JSON-LD so a title cannot close the script tag", () => {
    const raw = { name: "Apple </script> iPhone" };
    expect(serializeJsonLd(raw)).toBe('{"name":"Apple \\u003c/script> iPhone"}');
    expect(() => JSON.parse(serializeJsonLd(raw))).not.toThrow();
  });
});

describe("REEA-1168 AC-7 product-page structured data", () => {
  const pdpProduct: NormalizedProduct = {
    productId: "apple-iphone17-pro-256gb",
    title: "Apple iPhone 17 Pro 256Gb Silver",
    brand: "Apple",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
  };

  function liveOffer(overrides: Partial<LiveOffer> = {}): LiveOffer {
    return {
      merchant: "Wibi",
      domain: "wibi.com.kw",
      price: 314.9,
      currency: "KWD",
      url: "https://wibi.com.kw/products/apple-iphone-17-pro-256gb",
      inStock: true,
      collectedAt: new Date(NOW - 60 * 1000).toISOString(),
      method: "live",
      ...overrides,
    };
  }

  function buildPdp(
    offers: LiveOffer[],
    locale: "en" | "ar" = "en",
  ) {
    return buildProductStructuredData({
      product: pdpProduct,
      offers,
      locale,
      country: null,
      nowMs: NOW,
      origin: ORIGIN,
      canonicalProductId: "iphone-17-pro",
    });
  }

  it("emits one Product/Offer node for the painted fresh offer set", () => {
    const freshAt = new Date(NOW - 2 * 60 * 1000).toISOString();
    const node = buildPdp([
      liveOffer({ collectedAt: freshAt }),
      liveOffer({
        merchant: "Xcite",
        price: 319.9,
        url: "https://www.xcite.com/apple-iphone-17-pro-256gb/p",
        collectedAt: freshAt,
      }),
    ]);
    expect(node).not.toBeNull();
    expect(node!["@type"]).toBe("Product");
    expect(node!.url).toBe(`${ORIGIN}/product/iphone-17-pro`);
    expect(node!.sku).toBe("apple-iphone17-pro-256gb");
    expect(node!.offers).toHaveLength(2);
    expect(node!.offers[0].validFrom).toBe(freshAt);
    expect(node!.offers[0].priceValidUntil).toBe(
      new Date(Date.parse(freshAt) + STRUCTURED_DATA_FRESHNESS_MS).toISOString().slice(0, 10),
    );
    expect(node!.offers[0].seller.name).toBe("Wibi");
    expect(node!.description).toContain("314.9");
  });

  it("emits Arabic name/description on an Arabic PDP", () => {
    const node = buildPdp([liveOffer()], "ar");
    expect(node!.name).toContain("أسعار");
    expect(node!.description).toContain("الكويت");
    expect(node!.offers).toHaveLength(1);
  });

  it("emits no price claim when every row is stale or unstamped", () => {
    const staleAt = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(buildPdp([liveOffer({ collectedAt: staleAt })])).toBeNull();
    expect(buildPdp([liveOffer({ collectedAt: "" })])).toBeNull();
    expect(buildPdp([])).toBeNull();
  });
});
