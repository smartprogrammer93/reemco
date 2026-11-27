/**
 * REEA-1114 / REEA-1267 — filter-aware empty state: count the matches an
 * ACTIVE filter hides, so the results page can never tell a shopper "no match
 * found" when the shelf is only empty because our own In stock / market
 * filter removed rows. Pure and client-safe (same graph rules as
 * results-shelf.ts): no React, no I/O, no store — it rides the already-loaded
 * live snapshot the page renders.
 *
 * REEA-1267 — the ONE definition. The hidden set is derived from the SAME
 * painted shelf chain the renderer uses (`paintedShelfFromProducts` in
 * results-shelf.ts), not from a second confidence ladder:
 *  - the filter-off shelf is the payload's confident in-scope set as this page
 *    would paint it (payload `productScope` partition, page slice, per-query
 *    card budget, one card per productId, price rank);
 *  - the filter-on shelf is the same chain with the shopper's active
 *    selections applied;
 *  - the hidden cards are the filter-off cards the filter-on shelf does not
 *    paint, restricted to cards that carry ≥1 offer. A card with no offer at
 *    all is not hidden by a filter — there is nothing for the filter to remove
 *    (REEA-1114's documented contract, kept).
 *
 * That makes the escape count equal to what the reveal actually adds, and the
 * revealed set exactly the payload's confident in-scope products — no
 * fabricated rows, no `related`/`accessory` band item promoted into it (F-2).
 *
 * The market selection no longer hides a card (REEA-1142 keeps cross-market
 * offers on the shelf, labelled), so the only hiding filter is In stock; the
 * `country` branch stays in the type so a future market drop keeps working.
 *
 * No new server field: the count is derived from the live payload the page
 * already holds.
 */
import type { CountryCode } from "@/lib/country";
import { paintedShelfFromProducts } from "@/lib/results-shelf";
import type { NormalizedProduct } from "@/types/product";

/** The active filter that is hiding matches. */
export type HiddenFilter = "stock" | "country";

/** The cards an active filter is hiding, and which filter hides them. */
export interface HiddenShelfMatches {
  /** Exactly the payload cards the one-tap reveal adds to this page. */
  cards: NormalizedProduct[];
  /** The selection that hides them. */
  filter: HiddenFilter;
}

/** Legacy count shape the filter chips and the empty-state precedence read. */
export interface HiddenMatchReport {
  /** Confident matches hidden by the In stock selection. */
  stock: number;
  /** Confident matches hidden by the market selection. */
  country: number;
}

/**
 * REEA-1267 — the hidden set for one rendered page of a live snapshot.
 * `showOutOfStock` is the stock selection the page is currently rendering:
 * when it is true the stock filter is off, so nothing can be hidden by it.
 */
export function hiddenShelfMatches(
  products: readonly NormalizedProduct[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): HiddenShelfMatches {
  if (query.length === 0) return { cards: [], filter: "stock" };
  // The payload's confident in-scope set as the page would paint it with the
  // filter off — the reveal's exact target population.
  const withFilterOff = paintedShelfFromProducts(products, query, page, country, true);
  const withFilterOn = paintedShelfFromProducts(
    products,
    query,
    page,
    country,
    showOutOfStock,
  );
  const visibleIds = new Set(withFilterOn.map((p) => p.productId));
  const cards = withFilterOff.filter(
    (p) => !visibleIds.has(p.productId) && p.offers.length > 0,
  );
  return { cards, filter: "stock" };
}

/**
 * The chip/empty-state count, derived from the SAME hidden set the escape
 * renders, so the chip ("In stock · N hidden") and the escape ("N matches
 * hidden by In stock") can never disagree.
 */
export function hiddenMatchReport(
  products: readonly NormalizedProduct[],
  query: string,
  country: CountryCode | null,
  showOutOfStock: boolean,
  page = 1,
): HiddenMatchReport {
  const hidden = hiddenShelfMatches(products, query, page, country, showOutOfStock);
  if (hidden.filter === "stock") {
    return { stock: hidden.cards.length, country: 0 };
  }
  return { stock: 0, country: hidden.cards.length };
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
