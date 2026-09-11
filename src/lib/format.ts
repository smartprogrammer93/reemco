import { currencyForCountry, type CountryCode } from "@/lib/country";
import type { PriceOffer } from "@/types/product";

/**
 * REEA-488 item 3 + REEA-574 R2 — Kuwaiti display convention for KD figures:
 * at most TWO decimals on EVERY KD output, through ONE helper. Whole amounts
 * render bare ("KD 349" / "Save KD 3", never "KD 349.000"); any fraction
 * rounds half-expand (Intl default) and pads to hundredths ("KD 559.87",
 * "KD 6.50"), so the savings pill keeps its integer style while price sites
 * keep their trailing zero. Applied to hero price, ≈ twin, offer rows, colour
 * chips, alternatives and the savings pill, in both locales — the label space
 * is ASCII on every view. The cap is the REEA-281 ≤2 rule extended to the
 * KWD-native side too (spec `reea-574-craft-spec` R2): chip and twin of one
 * value must print identically.
 */
function kdDigitCount(value: number): number {
  const mille = Math.round(Math.abs(value) * 1000);
  if (mille % 1000 === 0) return 0; // whole amount — no decimals, no trailing-zero noise
  return 2; // any fraction caps at hundredths: 559.867 → "559.87"
}

/** THE KD formatter — plain KD-space digits for one figure (grouping kept, no
 *  currency prefix, maximumFractionDigits: 2). Every KD output in the app
 *  renders through here so one rounding rule covers hero price, twin, row,
 *  chip, alternative and savings pill alike (REEA-574 R2). */
export function formatKWD(value: number): string {
  const digits = kdDigitCount(value);
  try {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits, // ≤2 decimals, Intl half-expand rounding
    }).format(value);
  } catch {
    return value.toFixed(digits);
  }
}

/** Format a price with its currency. KWD renders in the Kuwaiti convention —
 *  "KD 349" / "KD 14.90" (REEA-488); every other ISO code keeps its Intl
 *  currency stamp as before. */
export function formatPrice(price: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  if (!code || code === "KWD") return `KD ${formatKWD(price)}`;
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
 * REEA-254 — KWD-space numeric of an offer figure. Every cross-retailer
 * COMPARISON (cheapest-of-card, ranking, colour-swatch best, row order) must
 * happen after this conversion: SAR 5,199 is cheaper than KWD 429.9 even
 * though the raw numerics read the other way round. Display paths keep using
 * the native figure via formatPrimaryPrice/formatCountryPrice; unknown codes
 * pass through unconverted (REEA-195 rule).
 */
export function toKwdNumeric(price: number, currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!code || code === "KWD") return price;
  const rate = TO_KWD[code];
  return rate ? price * rate : price;
}

/** Converted-side render of a reference conversion: at most two decimals —
 *  the exact fils precision belongs to KWD-native figures only (REEA-281 AC-2),
 *  a derived number must not read like a third decimal was measured. KWD lands
 *  as the REEA-488 KD form ("KD 40.72", whole figures bare — no trailing-zero
 *  noise on the derived side either); other codes keep their Intl stamp. */
function formatConverted(value: number, code: string): string {
  if (code === "KWD") return `KD ${formatKWD(value)}`;
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
  const kwd = toKwdNumeric(price, currency);
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

/** Sort offers so live answers lead (REEA-510: snapshot rows always ride
 *  below every live row), then in-stock items, then cheapest. REEA-254: the
 *  cheapest comparison runs in KWD-space so a SAR listing is compared against
 *  KWD listings on the same scale, not on raw numerics. REEA-604: the single
 *  ordering key is the NORMALIZED EFFECTIVE price (effectivePriceKwd) —
 *  coupon/was-price evidence folded in before the KWD-space comparison — so
 *  the ranked list promises best-effective-price-first, not lowest raw
 *  numeric. The coupon rides as the card's own best coupon (the same one the
 *  effective-price line prints under the hero figure). The key is pure and
 *  total on the served figures, so repeated loads of the same fetched set
 *  rank identically (stable Array.sort keeps the deterministic input order
 *  built by orderByAdapter on ties). */
export function sortOffers(
  offers: PriceOffer[],
  coupon?: { discount: string } | null,
): PriceOffer[] {
  const key = (o: PriceOffer): number =>
    effectivePriceKwd(o.price, o.currency, { wasPrice: o.wasPrice, couponDiscount: coupon?.discount });
  return [...offers].sort((a, b) => {
    if (!!a.fromSnapshot !== !!b.fromSnapshot) return a.fromSnapshot ? 1 : -1;
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return key(a) - key(b);
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

/** Parse a machine-readable coupon discount ("10% off" / "$5 off") onto a
 *  figure. Returns null when the string cannot be parsed — callers must never
 *  invent a number (spec §3.3: the effective price is always explained). */
function applyCouponDiscount(price: number, discount: string): number | null {
  const dollar = discount.match(/^\$\s?(\d+(?:\.\d+)?)\s+off$/i);
  if (dollar) return Math.max(0, price - parseFloat(dollar[1]));
  const percent = discount.match(/^(\d+(?:\.\d+)?)\s?%\s+off$/i);
  if (percent) {
    const pct = parseFloat(percent[1]);
    if (pct <= 100) return Math.max(0, price * (1 - pct / 100));
  }
  return null;
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
  return applyCouponDiscount(offer.price, coupon.discount);
}

/**
 * REEA-604 — THE normalized effective price: one number, KWD-based, for every
 * offer of the Kuwait-first site. It is what the shopper can actually pay:
 * the listed figure with machine-readable coupon evidence folded in, and the
 * retailer's own was-price honored when it reads LOWER than the listed figure
 * (the best attested amount wins; nothing beyond what the retailer served is
 * invented) — then converted through the REEA-195 reference table into
 * KWD-space. Every cross-currency ORDERING decision (offer-row order, card
 * ranking, best-price badge, savings math) runs on this number, so a KWD
 * listing and a SAR listing compete on comparable figures instead of raw
 * numerics ("Blink KD 349 next to Jarir SAR 79"). The key is pure arithmetic
 * on the served figures: repeated loads of the same fetched set rank
 * identically. Display paths keep showing the ORIGINAL stamped amount beside
 * this figure (formatPrimaryPrice/formatCountryPrice) — every offer keeps its
 * currency code visible, the normalized figure is additive, never a rewrite.
 */
export function effectivePriceKwd(
  price: number,
  currency: string,
  opts?: { wasPrice?: number; couponDiscount?: string | null },
): number {
  let base = price;
  // was-price evidence: when the retailer's own record shows a lower
  // achievable figure than the listed one, that figure IS the effective price.
  if (opts?.wasPrice != null && opts.wasPrice > 0 && opts.wasPrice < base) {
    base = opts.wasPrice;
  }
  const off = opts?.couponDiscount ? applyCouponDiscount(base, opts.couponDiscount) : null;
  if (off != null) base = off;
  return Math.max(0, toKwdNumeric(base, currency));
}
