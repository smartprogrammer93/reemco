/**
 * REEA-1114 — unit pins for the filter-aware empty-state classification.
 * The counter must never claim a match is hidden when the renderer would
 * have shown it, and must never blame a filter for a product that carries no
 * offer at all.
 */
import { describe, expect, it } from "vitest";
import {
  emptyMatchCase,
  hiddenMatchReport,
  hiddenMatchTotal,
} from "@/lib/hidden-matches";
import type { NormalizedProduct } from "@/types/product";

function product(
  productId: string,
  title: string,
  offers: NormalizedProduct["offers"],
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

const KWD_OOS = {
  merchant: "Sultan Center",
  price: 0.67,
  currency: "KWD",
  url: "https://sultan.example/p",
  inStock: false,
};
const KWD_IN = {
  merchant: "Xcite",
  price: 0.75,
  currency: "KWD",
  url: "https://xcite.example/p",
  inStock: true,
};
const SAR_IN = {
  merchant: "Danube Home",
  price: 5.8,
  currency: "SAR",
  url: "https://danube.example/p",
  inStock: true,
};

const PANADOL = product("panadol-24", "Panadol Pain Relief Tablets 24Tablets", [KWD_OOS]);
const PANADOL_SAR = product("panadol-24", "Panadol Pain Relief Tablets 24Tablets", [SAR_IN]);
const PANADOL_KWD = product("panadol-24", "Panadol Pain Relief Tablets 24Tablets", [KWD_IN]);
const NO_OFFERS = product("empty-row", "Panadol Empty Row", []);

describe("hiddenMatchReport — stock-hidden matches", () => {
  it("counts a confident match whose only in-market offer is out of stock", () => {
    expect(hiddenMatchReport([PANADOL], "panadol", "KW", false)).toEqual({
      stock: 1,
      country: 0,
    });
  });

  it("counts nothing when the stock filter is off", () => {
    expect(hiddenMatchReport([PANADOL], "panadol", "KW", true)).toEqual({
      stock: 0,
      country: 0,
    });
  });

  it("counts nothing when an in-stock offer renders", () => {
    expect(hiddenMatchReport([PANADOL_KWD], "panadol", "KW", false)).toEqual({
      stock: 0,
      country: 0,
    });
  });
});

describe("hiddenMatchReport — market no longer hides (REEA-1142)", () => {
  it("keeps a cross-market card visible, so it is not counted as hidden", () => {
    // The live `panadol` case: 4 confident Panadol products, all SAR offers,
    // default market Kuwait. REEA-1142 keeps those rows visible with their
    // market label ("Saudi price · ≈KD X") and renders the honest
    // "No Kuwait offer · Saudi price from KD X" headline — nothing is hidden,
    // so the empty state must not blame the market selection.
    expect(hiddenMatchReport([PANADOL_SAR], "panadol", "KW", false)).toEqual({
      stock: 0,
      country: 0,
    });
  });

  it("keeps the same zero with out-of-stock shown", () => {
    expect(hiddenMatchReport([PANADOL_SAR], "panadol", "KW", true)).toEqual({
      stock: 0,
      country: 0,
    });
  });

  it("counts nothing when the market filter is All", () => {
    expect(hiddenMatchReport([PANADOL_SAR], "panadol", null, false)).toEqual({
      stock: 0,
      country: 0,
    });
  });
});

describe("hiddenMatchReport — what is NOT a hidden match", () => {
  it("ignores a product that carries no offer at all", () => {
    expect(hiddenMatchReport([NO_OFFERS], "panadol", "KW", false)).toEqual({
      stock: 0,
      country: 0,
    });
  });

  it("ignores the related band (below the confidence threshold)", () => {
    // "Panadol Case" is accessory-shaped for a non-accessory query: related
    // chip, never a result card, so never part of the empty-state count.
    const related = product("panadol-case", "Panadol Case", [KWD_OOS]);
    expect(hiddenMatchReport([related], "panadol", "KW", false)).toEqual({
      stock: 0,
      country: 0,
    });
  });

  it("does not count an exact-SKU card the stock filter keeps visible", () => {
    // Letter-led code shape: REEA-822 keeps the code-carrying card on the
    // shelf even when every offer is out of stock, so it is not hidden.
    const sku = product("samsung-ef-ps931", "Samsung EF-PS931CBEGWW Case", [KWD_OOS]);
    expect(hiddenMatchReport([sku], "EF-PS931CBEGWW", "KW", false)).toEqual({
      stock: 0,
      country: 0,
    });
  });
});

describe("emptyMatchCase — precedence", () => {
  it("names the stock filter first (the default selection)", () => {
    expect(emptyMatchCase({ stock: 4, country: 2 }, false)).toEqual({
      kind: "b",
      filter: "stock",
      count: 4,
    });
  });

  it("falls back to the market filter when only it hides matches", () => {
    expect(emptyMatchCase({ stock: 0, country: 4 }, false)).toEqual({
      kind: "b",
      filter: "country",
      count: 4,
    });
  });

  it("keeps the outage copy when every lane failed and nothing is hidden", () => {
    expect(emptyMatchCase({ stock: 0, country: 0 }, true)).toEqual({ kind: "c" });
  });

  it("is a genuine no-match when nothing is hidden and lanes answered", () => {
    expect(emptyMatchCase({ stock: 0, country: 0 }, false)).toEqual({ kind: "a" });
  });

  it("never reports a genuine no-match while a filter hides rows", () => {
    expect(hiddenMatchTotal({ stock: 3, country: 0 })).toBe(3);
    expect(emptyMatchCase({ stock: 3, country: 0 }, false).kind).toBe("b");
  });
});
