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
import type { CountryCode } from "@/lib/country";
import { marketScope, scopeProductsByMarket } from "@/lib/market";
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
  // REEA-1142 AC1/AC3 — the market selection no longer DROPS other-market
  // offers (that emptied the only lane on panadol/cucumber/air fryer). Every
  // offer stays on the shelf, tagged to its market, and the card renderer
  // labels the cross-market rows and keeps them out of the headline claim.
  // The stock selection still filters exactly as before.
  const filtered = filterProductsByStock(
    scopeProductsByMarket([...products], marketScope(country)),
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

/* ---------------------------------------------------------------------------
 * REEA-1141 — the streamed shelf's one-card-per-product paint chain.
 *
 * Root cause of the duplicate-card regression: the per-flush boundary diffed
 * only against the IMMEDIATELY-PRIOR snapshot. A cached replay (stale-while-
 * revalidate lead / shared-layer warm) is painted by the lead flush, and when
 * a later live flush follows an EMPTY intermediate flush the adjacent diff
 * baseline is empty again, so the live shelf re-renders every product the
 * replay already painted — same productId twice, two different collectedAt
 * ages ("Checked 5 min ago" beside "Checked just now"). The live fan-out
 * carries the newest offer set for those products, so the stale shelf must be
 * REPLACED, not appended beside the fresh one.
 *
 * These helpers are the ONE definition of that chain, shared by the renderer
 * (ResultsClient's StageAppend boundaries) and the after() metrics fold, so
 * the counter can never describe a different population than the page paints:
 *  - a replay snapshot contributes nothing (the live stage paints the newest
 *    version of the same products; painting both is the duplicate),
 *  - a card already painted by ANY earlier flush is never painted again —
 *    cumulative, not adjacent, so an empty flush cannot reset the baseline.
 * Pure and dependency-light (no React, no I/O): client-safe.
 * ------------------------------------------------------------------------- */

/** What one streamed flush paints: nothing for a superseded replay, else the
 *  cards not already painted by an earlier flush. */
export function freshCardsForFlush(
  visible: readonly NormalizedProduct[],
  paintedIds: ReadonlySet<string>,
  replay: boolean,
): NormalizedProduct[] {
  if (replay) return [];
  const fresh: NormalizedProduct[] = [];
  for (const p of visible) if (!paintedIds.has(p.productId)) fresh.push(p);
  return fresh;
}

/** The cumulative painted-id set after one flush (unchanged for a replay). */
export function paintedIdsAfter(
  paintedIds: ReadonlySet<string>,
  fresh: readonly NormalizedProduct[],
): ReadonlySet<string> {
  if (fresh.length === 0) return paintedIds;
  const next = new Set(paintedIds);
  for (const p of fresh) next.add(p.productId);
  return next;
}

/**
 * REEA-1141 AC-4 — duplicate cards in a painted card set: cards that repeat a
 * productId already painted. Aggregate integer only (no ids leave the fold).
 * Post-fix this is 0 by construction; if the paint chain regresses it reads
 * the exact inflation so `comparison_depth` can be corrected.
 */
export function duplicateCardsOf(cards: readonly NormalizedProduct[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const p of cards) {
    if (seen.has(p.productId)) duplicates += 1;
    else seen.add(p.productId);
  }
  return duplicates;
}

/* ---------------------------------------------------------------------------
 * REEA-1162 — the late-answer fold's richness test.
 *
 * Root cause of the non-deterministic merged card (QA: base PS5 DualSense card
 * present 3/6 collections): the follow-up feed replaced the finalized shelf
 * only when the converged answer carried MORE PRODUCTS. But the merge pass
 * folds colourways into ONE card, so the converged answer is exactly the one
 * that carries MORE OFFERS while carrying FEWER products. The fold rejected it
 * and kept the stale forked shelf — sometimes (3/6), depending on how many
 * colourway cards the finalized snapshot had painted.
 *
 * Richness is therefore measured on the comparison evidence the shopper can
 * act on — offer rows — not on card count. A converged answer with more offers
 * always wins; an equal-offer answer wins when it is at least as merged
 * (fewer/equal cards), so the settled, deduped shelf replaces the provisional
 * one. A poorer answer never replaces what is already rendered.
 * ------------------------------------------------------------------------- */

/** Total offer rows a snapshot's products carry — the comparison evidence. */
export function snapshotOfferTotal(products: readonly NormalizedProduct[]): number {
  let total = 0;
  for (const p of products) total += p.offers?.length ?? 0;
  return total;
}

/**
 * Pick the snapshot to render when a late/converged answer arrives: the one
 * with more offer evidence, else the equally-rich answer that is at least as
 * merged (fewer cards), else the already-rendered one. Pure and client-safe:
 * same pair of snapshots, same choice, every render.
 */
export function preferRicherSnapshot<T extends { products: readonly NormalizedProduct[] }>(
  current: T | null | undefined,
  incoming: T | null | undefined,
): T | null {
  if (!incoming || !Array.isArray(incoming.products)) return current ?? null;
  if (!current || !Array.isArray(current.products)) return incoming;
  const incomingOffers = snapshotOfferTotal(incoming.products);
  const currentOffers = snapshotOfferTotal(current.products);
  if (incomingOffers > currentOffers) return incoming;
  if (incomingOffers === currentOffers && incoming.products.length <= current.products.length) {
    return incoming;
  }
  return current;
}

/**
 * Async mirror of the streamed paint chain over a run's stage promises: the
 * exact card sequence the served document paints (see StageAppend). Used by
 * the results page's after() tail to fold the duplicate-card counter and the
 * dedupe ratio over the SAME population the shopper saw. A rejected stage
 * contributes nothing — the honest state of a flush that never landed.
 */
export async function paintedShelfCardsAcrossStages(
  stages: readonly Promise<{ products: readonly NormalizedProduct[]; replay?: boolean }>[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): Promise<NormalizedProduct[]> {
  let paintedIds: ReadonlySet<string> = new Set<string>();
  const painted: NormalizedProduct[] = [];
  for (const stage of stages) {
    let snap: { products: readonly NormalizedProduct[]; replay?: boolean } | null;
    try {
      // REEA-1068 D1 — adopt through Promise.resolve so React thenables (SSR
      // prop shape) and plain promises both work here, exactly like the
      // renderer's union helper.
      snap = await Promise.resolve(stage);
    } catch {
      snap = null;
    }
    if (!snap) continue;
    const fresh = freshCardsForFlush(
      resultsShelfCards(snap, query, page, country, showOutOfStock),
      paintedIds,
      snap.replay === true,
    );
    painted.push(...fresh);
    paintedIds = paintedIdsAfter(paintedIds, fresh);
  }
  return painted;
}
