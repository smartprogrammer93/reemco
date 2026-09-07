/**
 * REEA-170 — country-filter helper tests: `?c=` sanitizing, currency → country
 * matching, offer/product filtering (including the alternatives recompute that
 * keeps every derived figure honoring the selection), result href building for
 * the pills and carry-over links, and the same-tab preference slot that lets
 * the choice survive a new search without re-selecting.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildResultsHref,
  countryForCurrency,
  filterOffersByCountry,
  filterProductsByCountry,
  matchesCountry,
  recallCountry,
  rememberCountry,
  resetCountryPrefs,
  sanitizeCountry,
} from "@/lib/country";
import type { NormalizedProduct } from "@/types/product";

beforeEach(() => resetCountryPrefs());

describe("sanitizeCountry", () => {
  it("normalizes allowlisted codes and degrades anything else to All", () => {
    expect(sanitizeCountry("kw")).toBe("KW");
    expect(sanitizeCountry(" sa ")).toBe("SA");
    expect(sanitizeCountry("EG")).toBe("EG");
    expect(sanitizeCountry("en-US")).toBeNull();
    expect(sanitizeCountry(undefined)).toBeNull();
  });
});

describe("currency matching", () => {
  it("maps storefront currencies to their country", () => {
    expect(countryForCurrency("KWD")).toBe("KW");
    expect(countryForCurrency("sar")).toBe("SA");
    expect(countryForCurrency("EGP")).toBe("EG");
    expect(countryForCurrency("USD")).toBeNull();
  });

  it("no selection matches everything; a selection matches its own offers", () => {
    expect(matchesCountry(null, "EGP")).toBe(true);
    expect(matchesCountry("KW", "KWD")).toBe(true);
    expect(matchesCountry("KW", "SAR")).toBe(false);
    expect(matchesCountry("EG", "EGP")).toBe(true);
  });
});

describe("offer/product filtering", () => {
  const offers = [
    { merchant: "Xcite", price: 400, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    { merchant: "Jarir", price: 380, currency: "SAR", url: "https://jarir.example/p", inStock: true },
    { merchant: "Amazon.eg", price: 350, currency: "EGP", url: "https://amz.example/dp/1", inStock: true },
  ];

  it("keeps matching offers in order and is a no-op with no selection", () => {
    expect(filterOffersByCountry(offers, "KW").map((o) => o.merchant)).toEqual(["Xcite"]);
    expect(filterOffersByCountry(offers, null)).toBe(offers);
  });

  it("recomputes alternative prices from the filtered set and drops dead ones", () => {
    const products: NormalizedProduct[] = [
      {
        productId: "airpods-pro-2",
        title: "Apple AirPods Pro 2",
        brand: "Apple",
        offers,
        coupons: [],
        variations: [],
        alternatives: [
          { productId: "alt-local", title: "AirPods 4", fromPrice: 70 },
          { productId: "alt-foreign", title: "Galaxy Buds", fromPrice: 60 },
        ],
      },
      {
        productId: "alt-local",
        title: "AirPods 4",
        brand: "Apple",
        offers: [...offers.slice(0, 1), { ...offers[1], price: 120 }],
        coupons: [],
        variations: [],
        alternatives: [],
      },
      {
        productId: "alt-foreign",
        title: "Galaxy Buds",
        brand: "Samsung",
        offers: offers.slice(1),
        coupons: [],
        variations: [],
        alternatives: [],
      },
    ];
    const [airpods] = filterProductsByCountry(products, "KW");
    expect(airpods.offers.map((o) => o.merchant)).toEqual(["Xcite"]);
    // The surviving alternative keeps its price from the FILTERED offers, and
    // an alternative left with no matching offer disappears entirely.
    expect(airpods.alternatives).toEqual([{ productId: "alt-local", title: "AirPods 4", fromPrice: 400 }]);
  });
});

describe("buildResultsHref", () => {
  it("carries q, page>1 and the country selection", () => {
    expect(buildResultsHref("airpods", 1, "KW")).toBe("/results?q=airpods&c=KW");
    expect(buildResultsHref("lg gram", 2, "EG")).toBe("/results?q=lg+gram&page=2&c=EG");
    expect(buildResultsHref("airpods", 1, null)).toBe("/results?q=airpods");
    expect(buildResultsHref("", 1, null)).toBe("/results");
  });
});

describe("same-tab preference slot", () => {
  it("records the choice for the next search's carry-over input", () => {
    expect(recallCountry()).toBeNull();
    rememberCountry("KW");
    expect(recallCountry()).toBe("KW");
    rememberCountry(null);
    expect(recallCountry()).toBeNull();
  });
});
