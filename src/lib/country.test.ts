/**
 * REEA-170 — country-filter helper tests: `?c=` sanitizing, currency → country
 * matching, offer/product filtering (including the alternatives recompute that
 * keeps every derived figure honoring the selection), result href building for
 * the pills and carry-over links, and the same-tab preference slot that lets
 * the choice survive a new search without re-selecting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildResultsHref,
  countryFromAcceptLanguage,
  countryForCurrency,
  filterOffersByCountry,
  filterProductsByCountry,
  matchesCountry,
  normalizeMarketCookie,
  readMarketCookie,
  recallCountry,
  rememberCountry,
  resetCountryPrefs,
  resolveCountrySelection,
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

describe("normalizeMarketCookie", () => {
  it("reads back the persisted pick, the explicit ALL, or unset", () => {
    expect(normalizeMarketCookie("sa")).toBe("SA");
    expect(normalizeMarketCookie(" EG ")).toBe("EG");
    expect(normalizeMarketCookie("all")).toBe("ALL");
    expect(normalizeMarketCookie("en-US")).toBeNull();
    expect(normalizeMarketCookie(undefined)).toBeNull();
  });
});

describe("countryFromAcceptLanguage", () => {
  it("maps a coarse region hint to the matching market tab", () => {
    expect(countryFromAcceptLanguage("ar-KW")).toBe("KW");
    expect(countryFromAcceptLanguage("en-KW,en;q=0.9")).toBe("KW");
    expect(countryFromAcceptLanguage("ar-SA")).toBe("SA");
    expect(countryFromAcceptLanguage("ar-EG,en-EG;q=0.8")).toBe("EG");
    expect(countryFromAcceptLanguage("ar-kw")).toBe("KW");
  });

  it("honors q-weight order, then first appearance", () => {
    // The higher-weighted locale decides even when it lists second.
    expect(countryFromAcceptLanguage("en-GB;q=0.8,ar-SA;q=0.9")).toBe("SA");
    // Equal weights keep document order.
    expect(countryFromAcceptLanguage("ar-EG,ar-KW;q=1.0")).toBe("EG");
  });

  it("unmapped locales and bare language tags keep the All default", () => {
    expect(countryFromAcceptLanguage("en-GB,en;q=0.9")).toBeNull();
    expect(countryFromAcceptLanguage("ar,en;q=0.9")).toBeNull();
    expect(countryFromAcceptLanguage("")).toBeNull();
    expect(countryFromAcceptLanguage(null)).toBeNull();
    expect(countryFromAcceptLanguage(undefined)).toBeNull();
  });
});

describe("resolveCountrySelection", () => {
  it("prefers the explicit ?c= over cookie and header layers", () => {
    expect(resolveCountrySelection("EG", "KW", "ar-KW")).toBe("EG");
    // An arrayed param reads its first value, like the page params contract.
    expect(resolveCountrySelection(["SA", "EG"], "KW", null)).toBe("SA");
  });

  it("an explicit All in the URL beats a persisted market", () => {
    expect(resolveCountrySelection("all", "KW", "ar-KW")).toBeNull();
    expect(resolveCountrySelection("ALL", undefined, "ar-EG")).toBeNull();
  });

  it("the persisted pill choice beats the header hint", () => {
    expect(resolveCountrySelection(undefined, "EG", "ar-KW")).toBe("EG");
    // Clicking All persists ALL — the unfiltered list survives the hint.
    expect(resolveCountrySelection(undefined, "ALL", "ar-KW")).toBeNull();
    expect(resolveCountrySelection("", "SA", "ar-KW")).toBe("SA");
  });

  it("falls to the header hint, then to the unfiltered default", () => {
    expect(resolveCountrySelection(undefined, undefined, "ar-KW")).toBe("KW");
    expect(resolveCountrySelection(undefined, "", "en-EG")).toBe("EG");
    expect(resolveCountrySelection(undefined, undefined, "en-GB")).toBeNull();
    expect(resolveCountrySelection(undefined, undefined, undefined)).toBeNull();
  });
});

describe("rememberCountry persistence (REEA-280)", () => {
  // A minimal document stub — the guard in country.ts only needs `.cookie`.
  const stubDocument = { cookie: "" };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  beforeAll(() => {
    Object.defineProperty(globalThis, "document", { value: stubDocument, configurable: true, writable: true });
  });
  afterAll(() => {
    if (saved) Object.defineProperty(globalThis, "document", saved);
    else delete (globalThis as { document?: unknown }).document;
  });

  it("one pill tap writes the single rc_market cookie", () => {
    resetCountryPrefs();
    rememberCountry("SA");
    expect(stubDocument.cookie).toContain("rc_market=SA");
    expect(stubDocument.cookie).toContain("SameSite=Lax");
    // The All pill persists the explicit unfiltered choice.
    rememberCountry(null);
    expect(stubDocument.cookie).toContain("rc_market=ALL");
    expect(readMarketCookie()).toBeNull();
    resetCountryPrefs();
  });

  it("a fresh tab recalls the persisted pick from the cookie alone", () => {
    // Fresh tab: the module slot is empty, only the stored cookie speaks.
    resetCountryPrefs();
    stubDocument.cookie = "other=1; rc_market=EG";
    expect(readMarketCookie()).toBe("EG");
    expect(recallCountry()).toBe("EG");
    resetCountryPrefs();
    expect(readMarketCookie()).toBeNull();
  });
});
