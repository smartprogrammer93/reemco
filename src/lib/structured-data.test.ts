import { describe, expect, it } from "vitest";
import {
  STRUCTURED_DATA_FRESHNESS_MS,
  buildResultsStructuredData,
  serializeJsonLd,
  type StructuredDataSnapshot,
} from "@/lib/structured-data";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

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

function build(products: NormalizedProduct[], locale: "en" | "ar" = "en") {
  return buildResultsStructuredData({
    snapshot: snapshot(products),
    query: QUERY,
    country: null,
    locale,
    nowMs: NOW,
    origin: ORIGIN,
  });
}

describe("REEA-1168 Product/Offer structured data", () => {
  it("emits a Product/Offer node for a fresh live observation only", () => {
    const freshAt = new Date(NOW - 5 * 60 * 1000).toISOString();
    const staleAt = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    const nodes = build([
      product({
        offers: [
          offer({ collectedAt: freshAt, price: 399.9 }),
          offer({ merchant: "Jarir", collectedAt: staleAt, price: 379 }),
          offer({ merchant: "Eureka", collectedAt: freshAt, fromSnapshot: true, price: 410 }),
          offer({ merchant: "Sultan Center", collectedAt: freshAt, price: 350, sanity: { status: "flagged" } }),
          offer({ merchant: "Blink", price: 355 }),
        ],
      }),
    ]);

    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node["@type"]).toBe("Product");
    expect(node.name).toBe("Apple iPhone 17 Pro 256GB");
    expect(node.sku).toBe("iphone-17-pro");
    expect(node.url).toBe(`${ORIGIN}/product/iphone-17-pro`);
    expect(node.brand).toEqual({ "@type": "Brand", name: "Apple" });
    // Only the fresh, live, unflagged offer carries a price claim.
    expect(node.offers).toHaveLength(1);
    const emitted = node.offers[0];
    expect(emitted["@type"]).toBe("Offer");
    expect(emitted.price).toBe(399.9);
    expect(emitted.priceCurrency).toBe("KWD");
    expect(emitted.availability).toBe("https://schema.org/InStock");
    expect(emitted.seller).toEqual({ "@type": "Organization", name: "Xcite" });
    expect(emitted.url).toBe("https://www.xcite.com/iphone-17-pro/p");
    // The observation timestamp is visible and the validity window is the
    // site's own freshness window, derived from it.
    expect(emitted.validFrom).toBe(freshAt);
    expect(emitted.priceValidUntil).toBe(
      new Date(NOW - 5 * 60 * 1000 + STRUCTURED_DATA_FRESHNESS_MS).toISOString().slice(0, 10),
    );
  });

  it("omits a product whose offers are all outside the freshness window", () => {
    const staleAt = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const nodes = build([
      product({
        productId: "sony-wh-1000xm6",
        title: "Sony WH-1000XM6",
        offers: [offer({ collectedAt: staleAt })],
      }),
    ]);
    expect(nodes).toEqual([]);
  });

  it("makes no price claim when a record has no usable observation stamp", () => {
    const nodes = build([
      product({
        offers: [offer({}), offer({ merchant: "Jarir" })],
      }),
    ]);
    expect(nodes).toEqual([]);
  });

  it("emits Arabic name/description on an Arabic page with the same Offer rules", () => {
    const freshAt = new Date(NOW - 60 * 1000).toISOString();
    const nodes = build(
      [
        product({
          offers: [offer({ collectedAt: freshAt, price: 399.9 })],
        }),
      ],
      "ar",
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toContain("أسعار");
    expect(nodes[0].description).toContain("أسعار");
    expect(nodes[0].description).toContain("الكويت");
    expect(nodes[0].offers[0].validFrom).toBe(freshAt);
    expect(nodes[0].offers[0].priceValidUntil).toBe(
      new Date(Date.parse(freshAt) + STRUCTURED_DATA_FRESHNESS_MS).toISOString().slice(0, 10),
    );
  });

  it("advertises the sitemap's catalog URL when a live SKU is catalog-covered", () => {
    const freshAt = new Date(NOW - 60 * 1000).toISOString();
    const nodes = build([
      product({
        productId: "apple-iphone17-pro-256gb",
        title: "Apple iPhone 17 Pro 256Gb Silver",
        offers: [offer({ collectedAt: freshAt, price: 399.9 })],
      }),
    ]);
    expect(nodes).toHaveLength(1);
    // The merge slug is still the SKU; the URL consolidates on the catalog id
    // the sitemap lists, so one product never advertises two addresses.
    expect(nodes[0].sku).toBe("apple-iphone17-pro-256gb");
    expect(nodes[0].url).toBe(`${ORIGIN}/product/iphone-17-pro`);
  });

  it("keeps the merge slug for a live-only SKU the catalog does not cover", () => {
    const freshAt = new Date(NOW - 60 * 1000).toISOString();
    const nodes = build([
      product({
        productId: "apple-iphone17-pro-512gb",
        title: "Apple iPhone 17 Pro 512GB",
        offers: [offer({ collectedAt: freshAt, price: 449.9 })],
      }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].url).toBe(`${ORIGIN}/product/apple-iphone17-pro-512gb`);
  });

  it("describes the same page slice the shelf renders (page 2 is empty for one card)", () => {
    const freshAt = new Date(NOW - 60 * 1000).toISOString();
    const products = [product({ offers: [offer({ collectedAt: freshAt })] })];
    const pageTwo = buildResultsStructuredData({
      snapshot: snapshot(products),
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
