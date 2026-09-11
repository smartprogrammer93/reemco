import { currencyForCountry, type CountryCode } from "@/lib/country";
import type { PriceOffer } from "@/types/product";

/**
 * REEA-488 item 3 + REEA-574 rev 1 (R2) — the ONE KD display convention for
 * every rendered figure: at most TWO decimals, half-expand rounding (the
 * Intl default), in both locales — the label space is ASCII on every view.
 * Whole amounts render bare ("KD 349", never "KD 349.000"); any fraction pads
 * to hundredths ("KD 14.90", "KD 6.50"), so a third decimal never leaks
 * (KD 559.867 → KD 559.87). The derived digit count also fixes the padded
 * length — this is the per-site minimumFractionDigits the rule keeps; every
 * KD surface (hero price, ≈ twin, offer rows, colour chips, alternatives
 * from-KD, savings pill) routes through this helper, so the chip and the
 * twin of one value print identically. `maxDecimals` stays in the call
 * signature for existing call sites; the ≤2 cap governs everywhere.
 */
function kdDigitCount(value: number, maxDecimals: number): number {
  const mille = Math.round(Math.abs(value) * 1000);
  const frac = mille % 1000; // the three decimal places alone
  void maxDecimals; // REEA-574: the cap is 2 everywhere — the 3rd-decimal tier is gone
  if (frac === 0) return 0; // whole amount — no decimals, no trailing-zero noise
  return 2; // any fraction pads to hundredths: 14.9 → "14.90"; Intl half-expands 559.867 → 559.87
}

/** Plain KD-space digits for a figure (grouping kept, no currency prefix) —
 *  also used by the detail-page swatch chips so one rounding rule covers
 *  every rendered KD number. */
export function formatKdDigits(value: number, maxDecimals = 3): string {
  const digits = kdDigitCount(value, maxDecimals);
  try {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
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
  if (!code || code === "KWD") return `KD ${formatKdDigits(price, 3)}`;
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
  if (code === "KWD") return `KD ${formatKdDigits(value, 2)}`;
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
 *  cheapest comparison runs in KWD-space (toKwdNumeric) so a SAR listing is
 *  compared against KWD listings on the same scale, not on raw numerics. */
export function sortOffers(offers: PriceOffer[]): PriceOffer[] {
  return [...offers].sort((a, b) => {
    if (!!a.fromSnapshot !== !!b.fromSnapshot) return a.fromSnapshot ? 1 : -1;
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return toKwdNumeric(a.price, a.currency) - toKwdNumeric(b.price, b.currency);
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
