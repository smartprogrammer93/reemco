import type { PriceOffer } from "@/types/product";

/** Format a price with its currency, e.g. "89.99 USD" -> "$89.99". */
export function formatPrice(price: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(price);
  } catch {
    return `${currency} ${price.toFixed(2)}`;
  }
}

/** Sort offers so in-stock items come first, then cheapest. */
export function sortOffers(offers: PriceOffer[]): PriceOffer[] {
  return [...offers].sort((a, b) => {
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return a.price - b.price;
  });
}

/** Human-readable expiry, or null when there is none. */
export function formatExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Compute the effective price for an offer given its best coupon, when the
 * coupon discount is machine-readable ("10% off" or "$5 off"). Returns null
 * when no coupon applies or the discount cannot be parsed — callers must
 * never invent a number (spec §3.3: the effective price is always explained).
 */
export function effectivePrice(
  offer: PriceOffer,
  coupon?: { code: string | null; discount: string } | undefined,
): number | null {
  if (!coupon) return null;
  const dollar = coupon.discount.match(/^\$\s?(\d+(?:\.\d+)?)\s+off$/i);
  if (dollar) return Math.max(0, offer.price - parseFloat(dollar[1]));
  const percent = coupon.discount.match(/^(\d+(?:\.\d+)?)\s?%\s+off$/i);
  if (percent) {
    const pct = parseFloat(percent[1]);
    if (pct <= 100) return Math.max(0, offer.price * (1 - pct / 100));
  }
  return null;
}
