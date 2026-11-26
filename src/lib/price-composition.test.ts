/**
 * REEA-1177 (Bet 6a) — the composition contract pins: one reconciling
 * statement, derived was-price coupon entries are not coupons, and a
 * conditional discount with an unknown applied value never subtracts a face
 * value from the headline.
 */
import { describe, expect, it } from "vitest";
import {
  composePrice,
  isWasPriceCoupon,
  realCouponsFor,
  withCouponComposition,
} from "@/lib/price-composition";
import type { Coupon, PriceOffer } from "@/types/product";

const XCITE: PriceOffer = {
  merchant: "Xcite",
  price: 319.9,
  currency: "KWD",
  url: "https://xcite.example/iphone",
  inStock: true,
  wasPrice: 409.9,
  savings: {
    amount: 90,
    struckPrice: 409.9,
    currentPrice: 319.9,
    currency: "KWD",
    baseline: { merchant: "Xcite", listedPrice: 409.9, currency: "KWD", kind: "was_price" },
  },
};

const DERIVED_COUPON: Coupon = {
  code: null,
  description: "KD 90",
  discount: "KD 90",
  expiresAt: null,
  merchant: "Xcite",
};

describe("composePrice (Bet 6a AC1/AC2)", () => {
  it("composes the Xcite markdown as listed − applied = effective", () => {
    const { effectivePrice, priceComposition } = composePrice({
      price: XCITE.price,
      currency: XCITE.currency,
      wasPrice: XCITE.wasPrice,
    });
    expect(effectivePrice).toBeCloseTo(319.9, 6);
    expect(priceComposition).toEqual({
      listed: 409.9,
      appliedDiscount: 90,
      effective: 319.9,
      kind: "was_price",
    });
  });

  it("a coupon composes listed − applied = effective and states kind:coupon", () => {
    const { priceComposition } = composePrice({
      price: 314.9,
      currency: "KWD",
      coupon: { code: "SAVE10", discount: "10% off" },
    });
    expect(priceComposition.kind).toBe("coupon");
    expect(priceComposition.listed).toBe(314.9);
    expect(priceComposition.appliedDiscount).toBeCloseTo(31.49, 2);
    expect(priceComposition.effective).toBeCloseTo(283.41, 2);
  });

  it("a conditional discount with an unknown applied value leaves effective null", () => {
    const { priceComposition, effectivePrice } = composePrice({
      price: 314.9,
      currency: "KWD",
      coupon: { code: "SAVE10", discount: "10% off orders over KD 50" },
    });
    expect(priceComposition.kind).toBe("coupon");
    expect(priceComposition.appliedDiscount).toBeNull();
    expect(priceComposition.effective).toBeNull();
    // Ordering falls back to the listed figure, never a subtracted face value.
    expect(effectivePrice).toBeCloseTo(314.9, 6);
  });
});

describe("derived was-price coupon entries (Bet 6a AC3)", () => {
  it("code:null + amount == savings.amount is a was-price markdown, not a coupon", () => {
    expect(isWasPriceCoupon(DERIVED_COUPON, [XCITE])).toBe(true);
    expect(realCouponsFor([DERIVED_COUPON], [XCITE])).toEqual([]);
  });

  it("an explicit code or an explicit 'off' text stays a real coupon", () => {
    expect(isWasPriceCoupon({ ...DERIVED_COUPON, code: "SAVE10" }, [XCITE])).toBe(false);
    expect(
      isWasPriceCoupon(
        { code: null, discount: "5% off" },
        [XCITE],
      ),
    ).toBe(false);
  });

  it("withCouponComposition applies a real coupon to its own merchant's offer only", () => {
    const eureka: PriceOffer = {
      merchant: "Eureka",
      price: 350,
      currency: "KWD",
      url: "https://eureka.example/p",
      inStock: true,
    };
    const coupon: Coupon = {
      code: "EUREKA10",
      description: "10% off",
      discount: "10% off",
      expiresAt: null,
      merchant: "Eureka",
    };
    const [xcite, eurekaOut] = withCouponComposition([XCITE, eureka], [coupon]);
    expect(xcite.effectivePrice).toBeCloseTo(319.9, 6);
    expect(eurekaOut.effectivePrice).toBeCloseTo(315, 6);
    expect(eurekaOut.priceComposition?.kind).toBe("coupon");
  });
});
