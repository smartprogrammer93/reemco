/**
 * REEA-1070 AC7 — the savings baseline the UI must name.
 *
 * A "Save" figure is only honest when it states what it is measured against:
 * the retailer listing's own struck/compare-at price. This module is the ONE
 * arithmetic + provenance rule shared by the results card offers
 * (PriceOffer, live-search finalizeGroups) and the product-page live rows
 * (LiveOffer, scraper). Pure and dependency-free so both server and client
 * surfaces derive the exact same figure.
 *
 * Arithmetic: struck − current, rounded to two decimals (AC7 ±0.01). A
 * baseline that is not strictly greater than the current price produces no
 * savings object at all — the UI then hides the pill rather than claiming a
 * save of zero or a negative number.
 */

export interface SavingsBaseline {
  /** Retailer whose listed price is the comparison baseline. */
  merchant: string;
  /** The listed/struck price the Save figure is measured against. */
  listedPrice: number;
  currency: string;
  /**
   * Provenance of the baseline. "was_price" = the retailer listing itself
   * carried a compare-at/struck price; the baseline is never inferred from a
   * different retailer's offer.
   */
  kind: "was_price";
  /** ISO collection stamp of the listing that carried the baseline. */
  observedAt?: string;
  /** Listing URL the baseline came from. */
  url?: string;
}

export interface OfferSavings {
  /** listedPrice − currentPrice, rounded to two decimals (AC7 ±0.01). */
  amount: number;
  /** The struck/list price the shopper is saving against. */
  struckPrice: number;
  /** The current effective price of this offer. */
  currentPrice: number;
  currency: string;
  baseline: SavingsBaseline;
}

export interface SavingsInput {
  merchant: string;
  price: number;
  currency: string;
  url?: string;
  wasPrice?: number;
  collectedAt?: string;
}

/** Two-decimal rounding that never leaks binary-float noise into the pill. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Derive the savings baseline for one offer. Returns null when there is no
 * usable compare-at evidence or when it does not exceed the current price.
 */
export function savingsFor(input: SavingsInput): OfferSavings | null {
  const { wasPrice, price } = input;
  if (wasPrice == null || !Number.isFinite(wasPrice) || !Number.isFinite(price)) return null;
  if (!(wasPrice > price)) return null;
  const amount = roundMoney(wasPrice - price);
  if (!(amount > 0)) return null;
  return {
    amount,
    struckPrice: wasPrice,
    currentPrice: price,
    currency: input.currency,
    baseline: {
      merchant: input.merchant,
      listedPrice: wasPrice,
      currency: input.currency,
      kind: "was_price",
      ...(input.collectedAt ? { observedAt: input.collectedAt } : {}),
      ...(input.url ? { url: input.url } : {}),
    },
  };
}
