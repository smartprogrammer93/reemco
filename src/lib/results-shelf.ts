/**
 * REEA-1099 — the ONE definition of a results-page shelf card.
 *
 * Why this module exists: `comparison_depth` is read against the measurement
 * plan's §4b gate as "results-page cards with ≥2 distinct named retailers ÷
 * results-page cards". The counter previously folded every product in the
 * live snapshot, which is a DIFFERENT population: it also counted the related
 * band (rendered as compact chips, explicitly NOT a result — REEA-964) and
 * products the country/stock selections drop before paint. Measured live on
 * `50cc3ae`: a two-query serve recorded 20 cards while the page painted 10.
 *
 * The renderer and the counter now share this chain, so one increment is
 * exactly the shelf the shopper's page painted — same query, same build, no
 * second definition to drift. Pure and client-safe: no React, no I/O, no
 * store.
 */
import { filterProductsByCountry, type CountryCode } from "@/lib/country";
import { filterProductsByStock } from "@/lib/stock";
import { exactSkuKeep } from "@/lib/relevance";
import { partitionByConfidence } from "@/lib/confidence";
import type { NormalizedProduct } from "@/types/product";

/** Cards per results page. Same slice the renderer applies (REEA-114/291). */
export const RESULTS_PAGE_SIZE = 20;

/**
 * Apply the shopper's country/stock selections, then the confidence partition
 * the page renders: primary (confident) rows become shelf cards, related
 * (below threshold, capped) rows become the related band — never cards.
 *
 * Selections apply BEFORE the partition, per snapshot, exactly as the staged
 * and plain render paths do (REEA-291/964). REEA-822: the exact-SKU keep
 * predicate rides the stock stage so a code-matched card survives the default
 * OOS drop and renders honestly as out-of-stock.
 */
export function shelfSectionsFromProducts(
  products: readonly NormalizedProduct[],
  query: string,
  country: CountryCode | null,
  showOutOfStock: boolean,
): { primary: NormalizedProduct[]; related: NormalizedProduct[] } {
  const filtered = filterProductsByStock(
    filterProductsByCountry([...products], country),
    showOutOfStock,
    exactSkuKeep(query),
  );
  return partitionByConfidence(query, filtered);
}

/** The shelf cards one page of a live snapshot renders (page 1 = default). */
export function shelfCardsFromProducts(
  products: readonly NormalizedProduct[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): NormalizedProduct[] {
  return shelfSectionsFromProducts(products, query, country, showOutOfStock).primary.slice(
    (page - 1) * RESULTS_PAGE_SIZE,
    page * RESULTS_PAGE_SIZE,
  );
}

/** Snapshot-level convenience wrapper over `shelfSectionsFromProducts`. */
export function resultsShelfSections(
  snap: { products: readonly NormalizedProduct[] },
  query: string,
  country: CountryCode | null,
  showOutOfStock: boolean,
): { primary: NormalizedProduct[]; related: NormalizedProduct[] } {
  return shelfSectionsFromProducts(snap.products, query, country, showOutOfStock);
}

/**
 * The results-page shelf card set for one served page. This is the population
 * the comparison-depth counter must fold: the same slice the renderer paints.
 */
export function resultsShelfCards(
  snap: { products: readonly NormalizedProduct[] },
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): NormalizedProduct[] {
  return shelfCardsFromProducts(snap.products, query, page, country, showOutOfStock);
}
