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

/**
 * REEA-195 — reference conversion factors into KWD, the primary display
 * currency of the Kuwait site. These are stable peg-style anchors (the KWD is
 * itself managed against a basket), not live FX ticks: they exist so a SAR/EGP
 * offer reads in KD at the same moment it is scraped, with the scraped figure
 * kept beside it. Unknown codes pass through unconverted.
 */
const TO_KWD: Readonly<Record<string, number>> = {
  SAR: 0.0816,
  USD: 0.3066,
  GBP: 0.4051,
  EUR: 0.3551,
  AED: 0.0834,
  EGP: 0.0061,
};

export interface PrimaryPrice {
  /** KWD-space numeric (or the raw price when nothing converts). */
  value: number;
  /** Primary label: KWD figure for every card; the scraped label rides behind
   *  it as a stamp when it differs, so nothing is silently rewritten. */
  label: string;
}

/**
 * KWD-primary price label for offer cards (REEA-195 AC-4). A KWD offer keeps
 * its figure untouched; any other retailer currency is converted with the
 * reference factor and both stamps render:
 *   SAR 150.00  →  "KD 12.24 · SAR 150.00"
 */
export function formatPrimaryPrice(price: number, currency: string): PrimaryPrice {
  const code = currency.trim().toUpperCase();
  if (!code || code === "KWD") return { value: price, label: formatPrice(price, "KWD") };
  const rate = TO_KWD[code];
  if (!rate) return { value: price, label: formatPrice(price, code) };
  const kwd = price * rate;
  return { value: kwd, label: `${formatPrice(kwd, "KWD")} · ${formatPrice(price, code)}` };
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
