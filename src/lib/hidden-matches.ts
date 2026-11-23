/**
 * REEA-1114 — filter-aware empty state: count the matches an ACTIVE filter
 * hides, so the results page can never tell a shopper "no match found" when
 * the shelf is only empty because our own In stock / market filter removed
 * rows. Pure and client-safe (same graph rules as results-shelf.ts): no
 * React, no I/O, no store — it rides the already-loaded live snapshot the
 * page renders.
 *
 * The classification is per product, in the SAME order the renderer applies
 * the selections (country first, then stock — see results-shelf.ts):
 *  - a confident match whose offers all belong to another market is hidden
 *    by the COUNTRY selection (it has offers, just none in the chosen
 *    market). Clearing the market reveals it;
 *  - a confident match with ≥1 offer in the chosen market but no in-stock
 *    offer is hidden by the STOCK selection. Showing out-of-stock reveals
 *    it;
 *  - a match with no offers at all is not hidden by either selection: there
 *    is nothing for a filter to remove, so it stays a plain no-match.
 *
 * Only PRIMARY (confident) matches are counted. The related band renders as
 * compact chips, explicitly "not a result" (REEA-964), so it is not part of
 * the count the empty state claims. Exact-SKU keeps (REEA-822) are already
 * visible under the stock filter and are therefore not counted as hidden.
 *
 * No new server field: the count is derived from the live payload the page
 * already holds. The only server addition is the aggregate
 * `filtered_empty_searches` counter (REEA-1114 AC6).
 */
import { filterOffersByCountry, type CountryCode } from "@/lib/country";
import { offerIsVisible } from "@/lib/stock";
import { exactSkuKeep } from "@/lib/relevance";
import { partitionByConfidence } from "@/lib/confidence";
import type { NormalizedProduct } from "@/types/product";

/** The active filter that is hiding matches. */
export type HiddenFilter = "stock" | "country";

export interface HiddenMatchReport {
  /** Confident matches hidden by the In stock selection. */
  stock: number;
  /** Confident matches hidden by the market selection. */
  country: number;
}

/**
 * Count the confident matches the active selections hide. `showOutOfStock`
 * is the stock selection the page is currently rendering: when it is true the
 * stock filter is off and only the market selection can hide matches.
 */
export function hiddenMatchReport(
  products: readonly NormalizedProduct[],
  query: string,
  country: CountryCode | null,
  showOutOfStock: boolean,
): HiddenMatchReport {
  if (query.length === 0) return { stock: 0, country: 0 };
  const primary = partitionByConfidence(query, [...products]).primary;
  const keep = exactSkuKeep(query);
  let stock = 0;
  let countryHidden = 0;
  for (const p of primary) {
    // Nothing for a filter to remove: the card simply carries no offer.
    if (p.offers.length === 0) continue;
    const inMarket = filterOffersByCountry([...p.offers], country);
    // Country runs first in the renderer's chain: no in-market offer at all
    // is a market-hidden match, not a stock-hidden one.
    if (country !== null && inMarket.length === 0) {
      countryHidden += 1;
      continue;
    }
    if (showOutOfStock) continue;
    // The stock filter keeps an exact-SKU card even when every offer is out
    // of stock (REEA-822): it renders honestly, so it is not hidden.
    if (inMarket.some(offerIsVisible)) continue;
    if (keep?.(p)) continue;
    stock += 1;
  }
  return { stock, country: countryHidden };
}

/** The total the empty-state copy names. */
export function hiddenMatchTotal(report: HiddenMatchReport): number {
  return report.stock + report.country;
}

/**
 * REEA-1114 AC2 — the three empty-state cases, in precedence order:
 *  - (b) a filter hid ≥1 confident match: name that filter and the count and
 *    offer the one-tap reveal. Stock is named first because it is the
 *    DEFAULT selection (AC3) — the case the trust failure came from;
 *  - (c) every dispatched lane failed: keep the existing outage copy;
 *  - (a) a genuine no-match: the existing spelling/broader-term copy.
 * A filter-hidden match is never reported as (a) or (c): we have the rows.
 */
export type EmptyMatchCase =
  | { kind: "a" }
  | { kind: "b"; filter: HiddenFilter; count: number }
  | { kind: "c" };

export function emptyMatchCase(
  report: HiddenMatchReport,
  collectionFailed: boolean,
): EmptyMatchCase {
  if (report.stock > 0) return { kind: "b", filter: "stock", count: report.stock };
  if (report.country > 0) return { kind: "b", filter: "country", count: report.country };
  if (collectionFailed) return { kind: "c" };
  return { kind: "a" };
}
