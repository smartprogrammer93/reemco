/**
 * REEA-1236 — the alternatives rail unit contract, locked.
 *
 * The defect (served head `bfac72c7f523`, `/results?q=iphone+15` EN): the lead
 * card `apple-iphone15-pro-128gb` painted "Saudi price from KD 383.44" while
 * its Alternatives rail painted "from KD 3,279" for a SAR 3,279 listing —
 * 12.3x the card's own figure. The rail read a KWD-space numeric, but the
 * stock/country selection passes rebuilt it from RAW native offer prices and
 * the rail hard-coded a KD label with no provenance.
 *
 * Checks:
 *  1. `alternativeFromPriceOf` derives the KWD-space figure AND records the
 *     winning offer's own currency + native amount; flagged offers never set
 *     a comparison figure (REEA-963 FR-1.4).
 *  2. `railFromPriceLabel` prints "≈KD X" for a convertible non-KWD source,
 *     "KD X" for KWD-native / legacy records, and the source currency with
 *     its own symbol when no reference conversion exists (REEA-195).
 *  3. AC2 exact figures: SAR 2,799 → "≈KD 228.40"; SAR 4,699 → "≈KD 383.44".
 *  4. AC4 render guard: a leaked raw figure above 3x the card's own lead is
 *     demoted to the offer's own native currency, never painted as KD.
 *  5. The results pipeline (`filterProductsByStock` / `filterProductsByCountry`)
 *     no longer rebuilds fromPrice from raw native numerics.
 */
import { describe, expect, it } from "vitest";
import {
  RAIL_UNIT_GUARD_FACTOR,
  alternativeFromPriceOf,
  railFromPriceLabel,
  railFromPriceLabelGuarded,
} from "@/lib/alternatives";
import { filterProductsByStock } from "@/lib/stock";
import { filterProductsByCountry } from "@/lib/country";
import type { NormalizedProduct, PriceOffer, ProductAlternative } from "@/types/product";

function sarOffer(price: number, extra: Partial<PriceOffer> = {}): PriceOffer {
  return {
    merchant: "Jarir",
    price,
    currency: "SAR",
    url: `https://jarir.example/${price}`,
    inStock: true,
    ...extra,
  };
}

describe("alternativeFromPriceOf — converted figure with provenance", () => {
  it("converts SAR into KWD-space and keeps the source currency + native amount", () => {
    const priced = alternativeFromPriceOf([sarOffer(3279)]);
    expect(priced).not.toBeNull();
    expect(priced!.fromCurrency).toBe("SAR");
    expect(priced!.fromNativePrice).toBe(3279);
    // 3279 x 0.0816 = 267.5664 — the card's own conversion factor.
    expect(priced!.fromPrice).toBeCloseTo(267.5664, 4);
  });

  it("picks the cheapest offer after conversion, not the smallest raw numeric", () => {
    const priced = alternativeFromPriceOf([
      sarOffer(3279), // ≈KD 267.57
      sarOffer(4699), // ≈KD 383.44
      { merchant: "Xcite", price: 300, currency: "KWD", url: "https://xcite.example/1", inStock: true },
    ]);
    expect(priced!.fromCurrency).toBe("SAR");
    expect(priced!.fromPrice).toBeCloseTo(267.5664, 4);
  });

  it("never lets a flagged offer set the comparison figure", () => {
    const priced = alternativeFromPriceOf([
      sarOffer(999, { sanity: { status: "flagged", reason: "outlier_low" } }),
      sarOffer(3279),
    ]);
    expect(priced!.fromPrice).toBeCloseTo(267.5664, 4);
    expect(alternativeFromPriceOf([
      sarOffer(999, { sanity: { status: "flagged", reason: "outlier_low" } }),
    ])).toBeNull();
  });
});

describe("railFromPriceLabel — never a bare native amount under a KD label", () => {
  it("AC2: SAR 2,799 prints ≈KD 228.40, not KD 2,799", () => {
    const a: ProductAlternative = {
      productId: "apple-iphone15-128gb",
      title: "Apple iPhone 15, 128 Apple A16 Bionic",
      fromPrice: 2799 * 0.0816,
      fromCurrency: "SAR",
      fromNativePrice: 2799,
    };
    expect(railFromPriceLabel(a)).toBe("≈KD 228.40");
  });

  it("AC2: SAR 4,699 prints ≈KD 383.44", () => {
    const a: ProductAlternative = {
      productId: "apple-iphone15-pro-128gb",
      title: "Apple iPhone 15 Pro",
      fromPrice: 4699 * 0.0816,
      fromCurrency: "SAR",
      fromNativePrice: 4699,
    };
    expect(railFromPriceLabel(a)).toBe("≈KD 383.44");
  });

  it("KWD-native and legacy records (no source code) keep the bare KD form", () => {
    expect(railFromPriceLabel({ productId: "a", title: "Case", fromPrice: 3.9 })).toBe("KD 3.90");
    expect(
      railFromPriceLabel({ productId: "a", title: "Case", fromPrice: 3.9, fromCurrency: "KWD" }),
    ).toBe("KD 3.90");
  });

  it("a source with no reference conversion prints its own currency symbol", () => {
    expect(
      railFromPriceLabel({
        productId: "a",
        title: "Imported item",
        fromPrice: 120,
        fromCurrency: "BHD",
        fromNativePrice: 120,
      }),
    ).toBe("BHD 120.000");
  });
});

describe("AC4 — no alternatives entry can print a figure >3x the card's own price", () => {
  const leaked: ProductAlternative = {
    productId: "apple-iphone15-128gb",
    title: "Apple iPhone 15, 128 Apple A16 Bionic",
    // the pre-fix leak: a raw SAR amount left in the KWD-space field
    fromPrice: 3279,
    fromCurrency: "SAR",
    fromNativePrice: 3279,
  };

  it("demotes a leaked raw figure to its own native currency", () => {
    // card's own lead: Jarir SAR 4,699 → ≈KD 383.44
    const label = railFromPriceLabelGuarded(leaked, 4699 * 0.0816);
    expect(label).toBe("SAR 3,279.00");
    expect(label).not.toContain("KD 3,279");
  });

  it("withholds the figure when even the native amount is unknown", () => {
    const label = railFromPriceLabelGuarded(
      { ...leaked, fromNativePrice: undefined },
      4699 * 0.0816,
    );
    expect(label).toBeNull();
  });

  it("the corrected figure stays well under the 3x ceiling", () => {
    const cardLead = 4699 * 0.0816;
    const label = railFromPriceLabelGuarded(
      { ...leaked, fromPrice: 3279 * 0.0816 },
      cardLead,
    );
    expect(label).toBe("≈KD 267.57");
    expect(3279 * 0.0816).toBeLessThanOrEqual(cardLead * RAIL_UNIT_GUARD_FACTOR);
  });

  it("a legitimate KWD-native accessory above 3x is not demoted (pairs case)", () => {
    // a KD 6.45 cable under a KD 1.00 card is real, not a unit leak
    const label = railFromPriceLabelGuarded(
      { productId: "p", title: "HDMI cable", fromPrice: 6.45, fromCurrency: "KWD" },
      1,
    );
    expect(label).toBe("KD 6.45");
  });
});

describe("results selection passes rebuild fromPrice in KWD-space", () => {
  const card: NormalizedProduct = {
    productId: "apple-iphone15-pro-128gb",
    title: "Apple iPhone 15 Pro",
    brand: "Apple",
    offers: [sarOffer(4699)],
    coupons: [],
    variations: [],
    alternatives: [
      { productId: "apple-iphone15-128gb", title: "Apple iPhone 15, 128 Apple A16 Bionic", fromPrice: 3279 },
    ],
  };
  const cheaper: NormalizedProduct = {
    productId: "apple-iphone15-128gb",
    title: "Apple iPhone 15, 128 Apple A16 Bionic",
    brand: "Apple",
    offers: [sarOffer(3279)],
    coupons: [],
    variations: [],
    alternatives: [],
  };

  it("filterProductsByStock converts the referenced offers (no raw 3,279)", () => {
    const out = filterProductsByStock([card, cheaper], false);
    const alt = out.find((p) => p.productId === card.productId)!.alternatives[0];
    expect(alt.fromPrice).toBeCloseTo(267.5664, 4);
    expect(alt.fromCurrency).toBe("SAR");
    expect(alt.fromNativePrice).toBe(3279);
    expect(railFromPriceLabel(alt)).toBe("≈KD 267.57");
  });

  it("filterProductsByCountry converts the referenced offers", () => {
    const out = filterProductsByCountry([card, cheaper], "SA");
    const alt = out.find((p) => p.productId === card.productId)!.alternatives[0];
    expect(alt.fromPrice).toBeCloseTo(267.5664, 4);
    expect(railFromPriceLabel(alt)).toBe("≈KD 267.57");
  });
});
