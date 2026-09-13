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

  // REEA-822 — the exact-SKU keep predicate: a card the query's part number
  // names must survive the default card-level drop when ALL its live offers
  // are out of stock (an honest zero may only state the SKU has no offers at
  // all, never that its only answer is merely unavailable).
  describe("exact-SKU keep predicate (REEA-822)", () => {
    const oosOnly: NormalizedProduct = {
      productId: "samsung-galaxy-s25-silicone-case-ef-ps931cbegww-black",
      title: "Samsung Galaxy S25 Silicone Case, EF-PS931CBEGWW – Black",
      brand: "Samsung",
      offers: [
        { merchant: "Xcite", price: 1, currency: "KWD", url: "https://xcite.example/p", inStock: false },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    };
    const oosFiller: NormalizedProduct = {
      productId: "generic-case",
      title: "Universal Silicone Case",
      brand: "",
      offers: [
        { merchant: "Blink", price: 2, currency: "KWD", url: "https://blink.example/p", inStock: false },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    };
    const keep = (p: NormalizedProduct) => p.title.includes("EF-PS931CBEGWW");

    it("keeps a kept all-OOS card with its full live offer set", () => {
      const filtered = filterProductsByStock([oosFiller, oosOnly], false, keep);
      // The non-matching OOS filler drops; only the code-matched card survives.
      expect(filtered.map((p) => p.productId)).toEqual([
        "samsung-galaxy-s25-silicone-case-ef-ps931cbegww-black",
      ]);
      // The kept card's offers stay UNFILTERED so the card renders its
      // honest out-of-stock state (StockDot out + OOS row) instead of an
      // offerless shell.
      expect(filtered[0].offers).toHaveLength(1);
      expect(filtered[0].offers[0].inStock).toBe(false);
    });

    it("never invents a card: a kept match still needs live offers", () => {
      const empty: NormalizedProduct = { ...oosFiller, productId: "no-offers", offers: [] };
      expect(filterProductsByStock([empty], false, keep)).toEqual([]);
    });

    it("drops non-matching all-OOS cards exactly as before", () => {
      expect(filterProductsByStock([oosFiller], false, keep)).toEqual([]);
    });

    it("is a no-op passthrough with the toggle enabled regardless of keep", () => {
      const list = [oosFiller, oosOnly];
      expect(filterProductsByStock(list, true, keep)).toBe(list);
    });

    it("is idempotent with the keep in place", () => {
      const once = filterProductsByStock([oosFiller, oosOnly], false, keep);
      expect(filterProductsByStock(once, false, keep)).toEqual(once);
    });
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
