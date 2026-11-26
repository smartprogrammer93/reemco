/**
 * REEA-1201 (Bet 7A-2) — pure helpers behind the honest shelf: the in-scope
 * count line's plural ladder and the thin-shelf honesty decision.
 *
 * Both read ONLY what the payload already carries:
 *  - the in-scope count is the number of primary-scope cards the renderer
 *    paints (see results-shelf.ts), never a second browser-side heuristic;
 *  - the thin-shelf test folds the SAME in-market comparison-merchant count
 *    the card's own basis prints (comparisonMerchantCount), so the page-level
 *    sentence can never contradict a card that says "best effective price".
 *
 * Pure and client-safe: no React, no I/O, no clock, no locale side effects.
 */
import type { CountryCode } from "@/lib/country";
import { comparisonMerchantCount } from "@/lib/offer-integrity";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import type { NormalizedProduct } from "@/types/product";

/** Cards per page are not needed here; every card on the rendered page counts. */

/**
 * True when at least one card carries ≥2 in-market retailers — i.e. the page
 * really is a cross-retailer comparison.
 */
export function shelfHasCrossRetailerMatch(
  products: readonly NormalizedProduct[],
  scope: CountryCode | null,
): boolean {
  return products.some((p) => comparisonMerchantCount(p.offers, scope) >= 2);
}

/**
 * AC 7b-3 — the thin shelf: there is at least one card and NO card has two
 * in-market retailers, so the page must say no cross-retailer match was found
 * instead of implying a comparison. An empty shelf is the empty state's job,
 * not this line's.
 */
export function isThinShelf(
  products: readonly NormalizedProduct[],
  scope: CountryCode | null,
): boolean {
  return products.length > 0 && !shelfHasCrossRetailerMatch(products, scope);
}

/**
 * The in-scope count template for `n` in `locale`. Arabic needs its own
 * dual/few/other ladder; English's dual/few slots carry the plural wording.
 * Kept here (not inline in the component) so the copy stays in the i18n table
 * and the ladder is testable.
 */
export function inScopeCountTemplate(locale: Locale, n: number): string {
  const t = getStrings(locale);
  if (n === 1) return t.inScopeCountOne;
  if (n === 2) return t.inScopeCountDual;
  if (n >= 3 && n <= 10) return t.inScopeCountFew;
  return t.inScopeCountMany;
}

/** Filled in-scope count sentence (used by tests and non-bidi surfaces). */
export function inScopeCountText(locale: Locale, n: number, query: string): string {
  return fill(inScopeCountTemplate(locale, n), { n, q: query });
}
