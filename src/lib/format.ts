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
