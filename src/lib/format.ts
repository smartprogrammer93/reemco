import { currencyForCountry, type CountryCode } from "@/lib/country";
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

/** Converted-side render of a reference conversion: at most two decimals —
 *  the exact fils precision belongs to KWD-native figures only (REEA-281 AC-2),
 *  a derived number must not read like a third decimal was measured. */
function formatConverted(value: number, code: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
}

/**
 * KWD-primary price label for offer cards (REEA-195 AC-4). A KWD offer keeps
 * its figure untouched; any other retailer currency is converted with the
 * reference factor and both stamps render:
 *   SAR 150.00  →  "≈KD 12.24 · SAR 150.00"
 * REEA-281 AC-2: the CONVERTED side is a reference figure — ≤2 decimals and
 * prefixed with ≈ — while the scraped stamp and every KWD-native figure keep
 * their exact rendered precision (fils included) unchanged.
 */
export function formatPrimaryPrice(price: number, currency: string): PrimaryPrice {
  const code = currency.trim().toUpperCase();
  if (!code || code === "KWD") return { value: price, label: formatPrice(price, "KWD") };
  const rate = TO_KWD[code];
  if (!rate) return { value: price, label: formatPrice(price, code) };
  const kwd = price * rate;
  return { value: kwd, label: `≈${formatConverted(kwd, "KWD")} · ${formatPrice(price, code)}` };
}

export interface CountryPrice {
  /** Numeric value of the LEAD figure, in the lead currency's space. */
  value: number;
  /** Lead figure: the selected country's currency; with no selection the
   *  offer's native figure leads and nothing is rewritten. */
  primary: string;
  /** Secondary converted figure (muted `.price-alt` stamp), null when the
   *  lead figure already carries every currency on the row. */
  alt: string | null;
}

/** Reference factor into KWD-space; KWD itself anchors the table at 1. */
function toKwdFactor(code: string): number | undefined {
  if (code === "KWD") return 1;
  return TO_KWD[code];
}

/**
 * REEA-283 — country-led price rows for the results surface. With a country
 * selection the lead figure reads in that country's currency (SA→SAR, KW→KWD,
 * EG→EGP) and the offer's scraped figure rides behind it as the muted stamp;
 * with no selection the offer-native figure leads and the KWD-space conversion
 * follows (the same pair formatPrimaryPrice produces, native-first now). A
 * KWD-native offer under a KW selection is one exact figure — no stamp. When
 * neither side shares a factor, the scraped figure passes through unconverted
 * (REEA-195 rule), never invented. Derived sides keep the REEA-281 ≈ + ≤2
 * decimals treatment; scraped figures keep their exact rendered precision.
 */
export function formatCountryPrice(
  price: number,
  currency: string,
  country: CountryCode | null,
): CountryPrice {
  const native = currency.trim().toUpperCase();
  const lead = country ? currencyForCountry(country) : native;

  // Lead is the native figure itself: keep it exact, convert only the stamp.
  if (!lead || lead === native) {
    const nativeRate = native ? toKwdFactor(native) : undefined;
    const alt =
      native && native !== "KWD" && nativeRate != null
        ? `≈${formatConverted(price * nativeRate, "KWD")}`
        : null;
    return { value: price, primary: formatPrice(price, lead || native || "KWD"), alt };
  }

  // Lead differs from native: bridge through KWD-space on the reference table.
  const nativeRate = native ? toKwdFactor(native) : undefined;
  const leadRate = toKwdFactor(lead);
  if (nativeRate == null || leadRate == null) {
    return { value: price, primary: formatPrice(price, native || lead), alt: null };
  }
  const converted = (price * nativeRate) / leadRate;
  return {
    value: converted,
    primary: `≈${formatConverted(converted, lead)}`,
    alt: formatPrice(price, native),
  };
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
