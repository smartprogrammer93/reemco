/**
 * REEA-1236 — the ONE unit contract for the alternatives / "Pairs with" rail
 * figures.
 *
 * A rail entry's `fromPrice` is KWD-space: the referenced item's cheapest
 * visible offer after the same conversion, was-price fold and sanity gate the
 * card headline uses (REEA-254 item B, REEA-604, REEA-963). The rail used to
 * print that numeric under a hard-coded KD label, and two selection passes
 * (`filterProductsByStock`, `filterProductsByCountry`) rebuilt it from the raw
 * native offer prices — so a SAR 3,279 listing painted "from KD 3,279" on a
 * card whose own headline said KD 383.44 (12.3x).
 *
 * Everything that derives a rail figure goes through this module:
 *   - `alternativeFromPriceOf` computes the converted figure AND records the
 *     source currency + its native amount, so the renderer can say "≈KD" when
 *     the source is not KWD and can fall back to the source currency when the
 *     reference conversion has no factor (REEA-195 pass-through).
 *   - `railFromPriceLabel` renders that figure, never a bare native amount
 *     under a KD label.
 *   - `railFromPriceLabelGuarded` is the AC4 render guard: a converted figure
 *     that exceeds 3x the card's own lead price is treated as a unit leak and
 *     demoted to the offer's own native currency (or withheld when the native
 *     amount is unknown) instead of overstating the alternative.
 */
import type { PriceOffer, ProductAlternative } from "@/types/product";
import { formatKWD, formatPrice, toKwdFactor } from "@/lib/format";
import { compositionOfOffer, effectiveKwdOfOffer } from "@/lib/price-composition";

/**
 * AC4 ceiling: an alternatives entry is a CHEAPER comparables claim, so a
 * printed figure above 3x the card's own lead price cannot be a converted
 * figure — it is a raw native amount that leaked past the conversion.
 */
export const RAIL_UNIT_GUARD_FACTOR = 3;

export interface AlternativeFromPrice {
  /** KWD-space numeric — the value every rail label must start from. */
  fromPrice: number;
  /** ISO code of the offer the figure was derived from. */
  fromCurrency: string;
  /** That offer's own effective amount in `fromCurrency`. */
  fromNativePrice: number;
}

/**
 * Derive one rail entry's "from" figure from the referenced product's offers.
 * Same rules as the collector's rollup (REEA-963 FR-1.4): flagged offers never
 * set a comparison figure; the cheapest offer in KWD-space wins; its own
 * currency and native amount ride along so the renderer can label it honestly.
 * Returns null when no offer can carry a price claim.
 */
export function alternativeFromPriceOf(
  offers: readonly PriceOffer[],
): AlternativeFromPrice | null {
  let best: { kwd: number; currency: string; native: number } | null = null;
  for (const offer of offers) {
    if (offer.sanity?.status === "flagged") continue;
    const kwd = effectiveKwdOfOffer(offer);
    if (!Number.isFinite(kwd)) continue;
    if (best != null && kwd >= best.kwd) continue;
    const composition = compositionOfOffer(offer);
    const native = composition.effective ?? composition.listed;
    if (!Number.isFinite(native)) continue;
    best = { kwd, currency: offer.currency, native };
  }
  return best == null
    ? null
    : { fromPrice: best.kwd, fromCurrency: best.currency, fromNativePrice: best.native };
}

/** Normalised source code of a rail figure; absent means legacy KWD-native. */
function railSourceCode(a: ProductAlternative): string {
  return (a.fromCurrency ?? "KWD").trim().toUpperCase();
}

/**
 * Intl currency stamps separate code and digits with U+00A0. The rest of the
 * card already normalises that to a plain space before painting (the same
 * `.replace(/\u00A0/g, " ")` the headline uses), so the rail does too — one
 * label space across EN and AR.
 */
function normaliseLabelSpaces(label: string): string {
  return label.replace(/\u00A0/g, " ");
}

/**
 * REEA-1236 AC1/AC2 — the rail "from" label. The numeric is KWD-space, so the
 * label states its provenance:
 *   KWD-native (or a legacy record with no code) → "KD 267.57"
 *   convertible non-KWD source                  → "≈KD 267.57"
 *   non-KWD source with no reference factor     → "SAR 3,279.00" (own symbol,
 *     never a bare native amount under a KD label — REEA-195 pass-through)
 */
export function railFromPriceLabel(a: ProductAlternative): string {
  const code = railSourceCode(a);
  if (code === "KWD") return formatPrice(a.fromPrice, "KWD");
  if (!toKwdFactor(code)) {
    return normaliseLabelSpaces(formatPrice(a.fromNativePrice ?? a.fromPrice, code));
  }
  return `≈KD ${formatKWD(a.fromPrice)}`;
}

/**
 * REEA-1236 AC4 — render guard for the CHEAPER-ALTERNATIVES list only. Every
 * alternative is, by construction, cheaper than the card it sits under
 * (REEA-488), so a printed figure above `RAIL_UNIT_GUARD_FACTOR` x the card's
 * own lead price is a unit leak. When the source currency is known the guard
 * demotes the entry to its own native amount (honest, never a KD label);
 * when even that is unknown the amount is withheld — the title still links,
 * but no overstated claim is painted.
 *
 * "Pairs with" entries are complementary accessories, not a cheaper-than-card
 * claim, so an accessory may legitimately cost several times a cheap card;
 * they render through `railFromPriceLabel` without this ceiling.
 */
export function railFromPriceLabelGuarded(
  a: ProductAlternative,
  cardLeadKwd: number | null | undefined,
): string | null {
  const code = railSourceCode(a);
  if (
    code !== "KWD" &&
    toKwdFactor(code) &&
    cardLeadKwd != null &&
    Number.isFinite(cardLeadKwd) &&
    cardLeadKwd > 0 &&
    a.fromPrice > cardLeadKwd * RAIL_UNIT_GUARD_FACTOR
  ) {
    return a.fromNativePrice != null && Number.isFinite(a.fromNativePrice)
      ? normaliseLabelSpaces(formatPrice(a.fromNativePrice, code))
      : null;
  }
  return railFromPriceLabel(a);
}
