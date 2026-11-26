/**
 * REEA-1177 (Bet 6a) — the ONE price-composition contract behind the shelf
 * and the PDP. It answers the shopper's only question honestly: what will I
 * actually pay at checkout, and what is that discount?
 *
 * Composition is `listed − appliedDiscount = effective` with a `kind`:
 *  - `was_price`: the retailer's own compare-at markdown (REEA-1070's named
 *    baseline). The listed figure is the struck price; effective is the
 *    current selling price.
 *  - `coupon`: an explicit coupon the hop delivered. Listed is the selling
 *    price before the coupon; effective is what the coupon leaves. When the
 *    coupon is conditional and its applied value cannot be parsed, effective
 *    is null and the UI must not subtract a face value.
 *
 * `effectivePrice` is the KWD-space figure used for ordering and the card
 * headline. When `effective` is null the ordering falls back to the listed
 * figure, and the card must not claim "best effective price".
 *
 * REEA-603's couponSignalOf derives a coupon entry from the was-price
 * markdown so the embedded coupon counter and the visible chip agree. Those
 * entries have `code:null` and a bare amount (no "off") — this module marks
 * them as was_price, never as a coupon, so the same KD cannot be presented
 * twice (Bet 6a AC3).
 */
import type { Coupon, PriceComposition, PriceOffer } from "@/types/product";
import { parseDiscountAmount, toKwdNumeric } from "@/lib/format";
import { roundMoney } from "@/lib/savings";

export interface ComposedOfferPrice {
  /** KWD-space amount used for ordering (effective, else listed). */
  effectivePrice: number;
  priceComposition: PriceComposition;
}

export interface ComposePriceInput {
  price: number;
  currency: string;
  wasPrice?: number;
  coupon?: { code?: string | null; discount: string } | null;
}

/**
 * Compose one offer's price statement. Pure arithmetic on served figures.
 * A coupon whose applied value is unknown leaves `effective` null and the
 * ordering falls back to the listed figure — never a face value subtracted.
 */
export function composePrice(input: ComposePriceInput): ComposedOfferPrice {
  const price = Math.max(0, input.price);
  const coupon = input.coupon ?? null;

  if (coupon) {
    const applied = parseDiscountAmount(price, coupon.discount);
    const composition: PriceComposition =
      applied == null
        ? { listed: price, appliedDiscount: null, effective: null, kind: "coupon" }
        : {
            listed: price,
            appliedDiscount: roundMoney(Math.min(price, applied)),
            effective: roundMoney(Math.max(0, price - applied)),
            kind: "coupon",
          };
    const orderingFigure = composition.effective ?? composition.listed;
    return {
      effectivePrice: Math.max(0, toKwdNumeric(orderingFigure, input.currency)),
      priceComposition: composition,
    };
  }

  // No explicit coupon: the retailer's own was-price evidence is the only
  // discount we can state. Preserve the REEA-604 rule that a lower was-price
  // is itself the achievable figure, and a higher one is the struck baseline.
  if (
    input.wasPrice != null &&
    Number.isFinite(input.wasPrice) &&
    input.wasPrice > 0 &&
    input.wasPrice !== price
  ) {
    const listed = Math.max(price, input.wasPrice);
    const effective = Math.min(price, input.wasPrice);
    const composition: PriceComposition = {
      listed,
      appliedDiscount: roundMoney(listed - effective),
      effective,
      kind: "was_price",
    };
    return {
      effectivePrice: Math.max(0, toKwdNumeric(effective, input.currency)),
      priceComposition: composition,
    };
  }

  const composition: PriceComposition = {
    listed: price,
    appliedDiscount: 0,
    effective: price,
    kind: "was_price",
  };
  return {
    effectivePrice: Math.max(0, toKwdNumeric(price, input.currency)),
    priceComposition: composition,
  };
}

/** The composition already on the served offer, else derived from its fields. */
export function compositionOfOffer(offer: PriceOffer): PriceComposition {
  if (offer.priceComposition) return offer.priceComposition;
  return composePrice({
    price: offer.price,
    currency: offer.currency,
    wasPrice: offer.wasPrice,
  }).priceComposition;
}

/** The KWD-space ordering figure for an offer (served field first). */
export function effectiveKwdOfOffer(offer: PriceOffer): number {
  if (typeof offer.effectivePrice === "number" && Number.isFinite(offer.effectivePrice)) {
    return Math.max(0, offer.effectivePrice);
  }
  return composePrice({
    price: offer.price,
    currency: offer.currency,
    wasPrice: offer.wasPrice,
  }).effectivePrice;
}

/**
 * REEA-1177 AC 6a-3 — a `coupons[]` entry is a was-price markdown, not a
 * coupon, when it has no code and its amount is exactly the offer's own
 * savings amount (or it is a bare amount string with no "off" — the shape
 * couponSignalOf derives from wasPrice). Real coupons carry a code or an
 * explicit "… off" text.
 */
export function isWasPriceCoupon(
  coupon: { code?: string | null; discount: string },
  offers: readonly PriceOffer[],
): boolean {
  if (coupon.code?.trim()) return false;
  const discount = coupon.discount.trim();
  const applied = parseDiscountAmount(1, discount);
  if (applied != null && !/%/.test(discount)) {
    const matches = offers.some((o) => {
      const savings =
        o.savings?.amount ??
        (o.wasPrice != null && o.wasPrice > o.price
          ? roundMoney(o.wasPrice - o.price)
          : null);
      return savings != null && Math.abs(savings - applied) < 0.011;
    });
    if (matches) return true;
  }
  // A bare amount ("KD 90") is the derived markdown; only explicit "off"
  // text (or a percent) is a coupon.
  return !/%/.test(discount) && !/\boff\b/i.test(discount);
}

/** Only the entries that are actually coupons (Bet 6a AC3). */
export function realCouponsFor(
  coupons: readonly Coupon[],
  offers: readonly PriceOffer[],
): Coupon[] {
  return coupons.filter((c) => !isWasPriceCoupon(c, offers));
}

/** Coupons that apply to one merchant (unstamped records ride every row). */
export function couponsForMerchant(
  coupons: readonly Coupon[],
  merchant: string,
): Coupon[] {
  return coupons.filter((c) => {
    const stamped = c.merchant?.trim();
    return stamped == null || stamped === "" || stamped === merchant;
  });
}

/** The best single coupon for one merchant's offer (largest applied value). */
export function bestCouponForOffer(
  offer: PriceOffer,
  coupons: readonly Coupon[],
): Coupon | null {
  const candidates = couponsForMerchant(coupons, offer.merchant);
  let best: Coupon | null = null;
  let bestApplied = -1;
  for (const coupon of candidates) {
    const composed = composePrice({
      price: offer.price,
      currency: offer.currency,
      wasPrice: offer.wasPrice,
      coupon,
    });
    const applied = composed.priceComposition.appliedDiscount ?? 0;
    if (applied > bestApplied) {
      best = coupon;
      bestApplied = applied;
    }
  }
  return best;
}

/**
 * REEA-1177 AC 6a-4 — apply the card's real coupons to the offers they
 * belong to before ordering, so every downstream key (row order, headline,
 * "from" price, shelf rank) reads the SAME effectivePrice the card prints.
 * Offers with no matching coupon keep their served composition.
 */
export function withCouponComposition(
  offers: readonly PriceOffer[],
  coupons: readonly Coupon[],
): PriceOffer[] {
  return offers.map((offer) => {
    const coupon = coupons.length > 0 ? bestCouponForOffer(offer, coupons) : null;
    const composed = composePrice({
      price: offer.price,
      currency: offer.currency,
      wasPrice: offer.wasPrice,
      coupon,
    });
    return {
      ...offer,
      effectivePrice: composed.effectivePrice,
      priceComposition: composed.priceComposition,
    };
  });
}
