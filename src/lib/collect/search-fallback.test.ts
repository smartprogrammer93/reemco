/**
 * REEA-85 — retailer-search fallback parser tests.
 * Fixtures captured live from the retailer endpoints on 2026-09-05
 * (trimmed to the fields the parsers consume).
 */
import { describe, expect, it } from "vitest";
import {
  parseEurekaSearch,
  parseShopifyProducts,
  parseXciteSearch,
  titleMatchScore,
} from "@/lib/collect/search-fallback";

const PRODUCT = "Sony WH-1000XM6 Wireless Noise Cancelling Headphones";

describe("titleMatchScore", () => {
  it("scores overlap and ignores tiny tokens", () => {
    expect(titleMatchScore("Sony WH-1000XM6 Wireless Headphones", PRODUCT)).toBeGreaterThan(0.5);
    expect(titleMatchScore("Apple iPhone case", PRODUCT)).toBeLessThan(0.2);
    expect(titleMatchScore("", PRODUCT)).toBe(0);
  });
});

describe("parseXciteSearch", () => {
  const fixture = {
    results: [
      {
        hits: [
          {
            name: "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black",
            slug: "sony-wireless-noise-cancelling-headphones-wh1000xm5-black",
            price: 79.9,
            unmodifiedPrice: 109.9,
            currency: "KWD",
            inStock: true,
            status_key: "InStock",
          },
          { name: "LG TV Stand", slug: "lg-tv-stand", price: 12 },
        ],
      },
    ],
  };

  it("picks the best-matching hit with provenance fields", () => {
    const found = parseXciteSearch(fixture, PRODUCT);
    expect(found?.price).toBe(79.9);
    expect(found?.currency).toBe("KWD");
    expect(found?.url).toContain("xcite.com/sony-wireless-noise-cancelling-headphones");
    expect(found?.inStock).toBe(true);
    expect(found?.wasPrice).toBe(109.9);
  });

  it("returns null when no hit matches", () => {
    expect(parseXciteSearch({ results: [{ hits: [] }] }, PRODUCT)).toBeNull();
    expect(parseXciteSearch(null, PRODUCT)).toBeNull();
  });
});

describe("parseShopifyProducts", () => {
  const fixture = {
    products: [
      {
        title: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
        handle: "sony-wh-1000xm6-black",
        variants: [{ price: "149.900", available: false }],
      },
      { title: "Gift Card", handle: "gift-card", variants: [{ price: "5.000" }] },
    ],
  };

  it("maps the best-matching product and stock state", () => {
    const found = parseShopifyProducts(fixture, PRODUCT);
    expect(found?.price).toBeCloseTo(149.9);
    expect(found?.url).toBe("https://blink.com.kw/products/sony-wh-1000xm6-black");
    expect(found?.inStock).toBe(false);
  });

  it("defaults inStock true when the variant omits availability", () => {
    const p = {
      products: [
        {
          title: "Sony WH-1000XM6 Headphones",
          handle: "sony-xm6",
          variants: [{ price: "100.000" }],
        },
      ],
    };
    expect(parseShopifyProducts(p, PRODUCT)?.inStock).toBe(true);
  });
});

describe("parseEurekaSearch", () => {
  const fixture = {
    hits: [
      {
        itmn: "Sony Wireless Noise Cancelling Headphone WH1000XM6 Black",
        objectID: "275100",
        lprc: 126.533,
        clprc: 94.9,
        avaqt: 3,
      },
      { itmn: "Samsung Charger", objectID: "1", clprc: 2 },
    ],
  };

  it("maps title/price/stock and the PDP url shape", () => {
    const found = parseEurekaSearch(fixture, PRODUCT);
    expect(found?.price).toBe(94.9);
    expect(found?.wasPrice).toBe(126.533);
    expect(found?.inStock).toBe(true);
    expect(found?.url).toBe(
      "https://www.eureka.com.kw/en/Sony_Wireless_Noise_Cancelling_Headphone_WH1000XM6_Black/275100",
    );
  });

  it("treats avaqt 0 as out of stock", () => {
    const p = { hits: [{ ...fixture.hits[0], avaqt: 0 }] };
    expect(parseEurekaSearch(p, PRODUCT)?.inStock).toBe(false);
  });
});
