/**
 * REEA-186 — stock-selection helper tests: `?oos=` sanitizing, offer/product
 * filtering (hide known out-of-stock listings, drop empty cards, recompute
 * the alternatives' fromPrice from the visible offers), the result-href flag
 * the toggle and carry-over links share, and the same-tab preference slot.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildResultsHref } from "@/lib/country";
import {
  bestBadgeIndex,
  filterOffersByStock,
  filterProductsByStock,
  offerIsVisible,
  recallShowOutOfStock,
  rememberShowOutOfStock,
  resetStockPrefs,
  sanitizeShowOutOfStock,
} from "@/lib/stock";
import type { NormalizedProduct } from "@/types/product";

beforeEach(() => resetStockPrefs());

describe("sanitizeShowOutOfStock", () => {
  it("normalizes the checkbox submissions and degrades unset to null", () => {
    expect(sanitizeShowOutOfStock("1")).toBe(true);
    expect(sanitizeShowOutOfStock(" TRUE ")).toBe(true);
    // Unchecked hidden field submits the empty value; "0"/"false" are explicit hides.
    expect(sanitizeShowOutOfStock("")).toBe(false);
    expect(sanitizeShowOutOfStock("0")).toBe(false);
    expect(sanitizeShowOutOfStock("false")).toBe(false);
    expect(sanitizeShowOutOfStock(undefined)).toBeNull();
    expect(sanitizeShowOutOfStock("banana")).toBeNull();
  });
});

describe("offer filtering", () => {
  const offers = [
    { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    { merchant: "Jarir", price: 69, currency: "SAR", url: "https://jarir.example/p", inStock: false },
    { merchant: "Blink", price: 77, currency: "KWD", url: "https://blink.example/p", inStock: true },
  ];

  it("only a KNOWN out-of-stock hides; missing signal stays visible", () => {
    expect(offerIsVisible({ inStock: true })).toBe(true);
    expect(offerIsVisible({ inStock: false })).toBe(false);
  });

  it("hides out-of-stock offers by default, keeps them with the toggle", () => {
    expect(filterOffersByStock(offers, false).map((o) => o.merchant)).toEqual(["Xcite", "Blink"]);
    expect(filterOffersByStock(offers, true)).toBe(offers);
  });
});

describe("product filtering", () => {
  const products: NormalizedProduct[] = [
    {
      productId: "headphones",
      title: "Sony WH-1000XM6",
      brand: "Sony",
      offers: [
        { merchant: "Jarir", price: 69, currency: "SAR", url: "https://jarir.example/p", inStock: false },
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [
        { productId: "alt-live", title: "XM5", fromPrice: 60 },
        { productId: "alt-dead", title: "Old Buds", fromPrice: 50 },
      ],
    },
    {
      productId: "alt-live",
      title: "XM5",
      brand: "Sony",
      offers: [
        { merchant: "Blink", price: 66, currency: "KWD", url: "https://blink.example/p", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
    {
      productId: "alt-dead",
      title: "Old Buds",
      brand: "Anker",
      offers: [
        { merchant: "Eureka", price: 50, currency: "KWD", url: "https://eureka.example/p", inStock: false },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
  ];

  it("drops OOS offer rows, empty cards and dead alternatives", () => {
    const filtered = filterProductsByStock(products, false);
    expect(filtered.map((p) => p.productId)).toEqual(["headphones", "alt-live"]);
    const [headphones] = filtered;
    expect(headphones.offers.map((o) => o.merchant)).toEqual(["Xcite"]);
    // Surviving alternative re-priced from its visible offers; the all-OOS
    // alternative disappears instead of carrying a stale fromPrice.
    expect(headphones.alternatives).toEqual([{ productId: "alt-live", title: "XM5", fromPrice: 66 }]);
  });

  it("is a no-op passthrough with the toggle enabled", () => {
    expect(filterProductsByStock(products, true)).toBe(products);
  });

  it("is idempotent — the client pass over already-filtered server data changes nothing", () => {
    const once = filterProductsByStock(products, false);
    expect(filterProductsByStock(once, false)).toEqual(once);
  });
});

describe("Best-price badge index (REEA-213)", () => {
  const withOffers = (
    id: string,
    offers: NormalizedProduct["offers"],
  ): NormalizedProduct => ({
    productId: id,
    title: id,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
  });

  it("rides the first card that has any in-stock offer", () => {
    const list = [
      withOffers("oos-head", [{ merchant: "Xcite", price: 5, currency: "KWD", url: "u", inStock: false }]),
      withOffers("stocked-next", [{ merchant: "Jarir", price: 9, currency: "SAR", url: "u", inStock: true }]),
    ];
    expect(bestBadgeIndex(list)).toBe(1);
  });

  it("falls back to the first card when nothing is stocked; -1 on an empty list", () => {
    const allOut = [withOffers("a", [{ merchant: "Xcite", price: 5, currency: "KWD", url: "u", inStock: false }])];
    expect(bestBadgeIndex(allOut)).toBe(0);
    expect(bestBadgeIndex([])).toBe(-1);
  });
});

describe("result href with the stock flag", () => {
  it("rides oos=1 beside q/c and keeps old URLs unchanged otherwise", () => {
    expect(buildResultsHref("airpods", 1, null, true)).toBe("/results?q=airpods&oos=1");
    expect(buildResultsHref("airpods", 2, "KW", true)).toBe("/results?q=airpods&page=2&c=KW&oos=1");
    expect(buildResultsHref("airpods", 1, null)).toBe("/results?q=airpods");
  });
});

describe("same-tab preference slot", () => {
  it("records the toggle state for the next search's carry-over input", () => {
    expect(recallShowOutOfStock()).toBeNull();
    rememberShowOutOfStock(true);
    expect(recallShowOutOfStock()).toBe(true);
    rememberShowOutOfStock(false);
    expect(recallShowOutOfStock()).toBe(false);
  });
});
