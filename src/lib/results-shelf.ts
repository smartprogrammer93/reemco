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
import { isCrossMarketOffer, marketViewScope, scopeProductsByMarket } from "@/lib/market";
import { effectiveKwdOfOffer } from "@/lib/price-composition";
import { comparisonMerchantCount } from "@/lib/offer-integrity";
import { filterProductsByStock } from "@/lib/stock";
import { carriesExactModel, exactModelQuery, exactSkuKeep, modelIdentityTokens } from "@/lib/relevance";
import {
  CONFIDENCE_THRESHOLD,
  RELATED_CAP,
  matchConfidence,
  partitionByConfidence,
} from "@/lib/confidence";
import type { NormalizedProduct } from "@/types/product";
import type { LiveSearchResult } from "@/lib/collect/coverage";

/** Cards per results page. Same slice the renderer applies (REEA-114/291). */
export const RESULTS_PAGE_SIZE = 20;

/**
 * REEA-1201 (Bet 7A-2) — the three sections the honest shelf renders:
 * primary shelf cards, the labelled accessory band, and the existing related
 * band. Accessory cards NEVER enter `primary` (AC 7b-2).
 */
export interface ShelfSections {
  primary: NormalizedProduct[];
  related: NormalizedProduct[];
  accessory: NormalizedProduct[];
}

/**
 * Apply the shopper's country/stock selections, then the payload's scope
 * partition when the relevance gate supplies `productScope`; otherwise the
 * pre-7A confidence partition (the same one every existing surface uses).
 *
 * REEA-1201: the browser does NOT invent `productScope`. When the payload
 * carries it, the value is read as-is — `primary`/`variant` become shelf
 * cards, `accessory` the labelled band, `consumable` the related band. A card
 * that predates the gate keeps the existing confidence ladder for itself only,
 * so a partial rollout cannot silently demote a primary card.
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
): ShelfSections {
  // REEA-1142 AC1/AC3 — the market selection no longer DROPS other-market
  // offers (that emptied the only lane on panadol/cucumber/air fryer). Every
  // offer stays on the shelf, tagged to its market, and the card renderer
  // labels the cross-market rows and keeps them out of the headline claim.
  // The stock selection still filters exactly as before.
  const filtered = filterProductsByStock(
    scopeProductsByMarket([...products], marketViewScope(country)),
    showOutOfStock,
    exactSkuKeep(query),
  );
  const sections = hasPayloadScope(filtered)
    ? scopeSections(filtered, query)
    : confidenceSections(filtered, query);
  // REEA-1177 AC 6a-4 — the primary shelf ranks by the SAME effective price
  // the card headline prints (lowest in-market effective first).
  // REEA-1261 AC-1 — on a brand+model query the exact model leads (see
  // rankPrimaryByEffective), so a cross-market-only exact card cannot be
  // buried under cheaper neighbours of another brand.
  const ranked = {
    ...sections,
    primary: rankPrimaryByEffective(
      sections.primary,
      marketViewScope(country),
      query,
    ),
  };
  // REEA-1178 AC1 — the page-level invariant: no two shelf cards share a
  // productId. The collector resolves group collisions (a "+ Wireless
  // Charger" bundle reusing the base phone's tuple got its own "-bundle"
  // identity), and this is the guardrail that keeps the invariant true for
  // every future merge pass: a twin id is painted once, first-ranked wins,
  // and the counter folds the SAME chain so depth can never count an artefact
  // the shopper does not see. Applied AFTER the REEA-1177 ranking so the
  // survivor is the card the page would have led with.
  return {
    primary: uniqueCardsByProductId(ranked.primary),
    related: uniqueCardsByProductId(ranked.related),
    accessory: uniqueCardsByProductId(ranked.accessory),
  };
}

/* ---------------------------------------------------------------------------
 * REEA-1201 (Bet 7A-2) — the payload-scope partition.
 *
 * The relevance gate (REEA-1200) stamps `productScope` per card. The UI reads
 * that value; it never computes a scope of its own. A snapshot with no scope
 * field at all keeps the pre-7A confidence partition byte-for-byte, and a card
 * that lacks the field while its siblings carry one keeps that same confidence
 * ladder for itself only — the safe bridge while the gate rolls out.
 * ------------------------------------------------------------------------- */

/** True when at least one card carries the gate's scope decision. */
export function hasPayloadScope(products: readonly NormalizedProduct[]): boolean {
  return products.some((p) => p.productScope != null);
}

function confidenceSections(
  products: readonly NormalizedProduct[],
  query: string,
): ShelfSections {
  const sections = partitionByConfidence(query, products);
  return { primary: sections.primary, related: sections.related, accessory: [] };
}

function scopeSections(
  products: readonly NormalizedProduct[],
  query: string,
): ShelfSections {
  const primary: NormalizedProduct[] = [];
  const related: NormalizedProduct[] = [];
  const accessory: NormalizedProduct[] = [];
  for (const p of products) {
    const scope = p.productScope;
    // REEA-1200 AC 7a-6 — primary/variant scope is the in-scope set. The gate
    // never stamps a primary/variant card with `related` (an off-scope row is
    // bucketed accessory/consumable), so "no `related` card fills a primary
    // slot" holds by construction of the classifier, not by a second filter
    // here — one definition, one place.
    if (scope === "primary" || scope === "variant") {
      primary.push(p);
      continue;
    }
    if (scope === "accessory") {
      // REEA-1261 — an accessory-scoped card whose match reason is `related`
      // is not an accessory OF the queried product; it is a different product
      // that merely shared a token (a Razer Ornata V3 under "keychron v3
      // max"). It belongs in the related band the page labels "Related items
      // — not an exact match", never in the accessory band whose label claims
      // it complements the query. Genuine accessories (a case that repeats the
      // device's identity) keep the accessory band.
      if (p.matchReason === "related") {
        if (related.length < RELATED_CAP) related.push(p);
      } else {
        accessory.push(p);
      }
      continue;
    }
    if (scope === "consumable") {
      if (related.length < RELATED_CAP) related.push(p);
      continue;
    }
    // No scope on this card: keep the existing confidence ladder for it only.
    const score = matchConfidence(query, p.title);
    if (score >= CONFIDENCE_THRESHOLD) primary.push(p);
    else if (score > 0 && related.length < RELATED_CAP) related.push(p);
  }
  return { primary, related, accessory };
}

/**
 * REEA-1177 AC 6a-4 — the primary shelf ranks by the SAME effective price the
 * card headline prints: lowest in-market effective first. Products with no
 * in-market offer (the AC 6d-3 exception) follow every local card, ordered by
 * their own effective figure; they never hold the "first card" claim.
 *
 * REEA-1261 AC-1 — the exception to that exception: on a brand+model query
 * ("keychron v3 max") the card that answers the shopper's exact model leads
 * the shelf even when its only offer is cross-market. The shopper asked for
 * THAT product; a cheaper neighbour of another brand must never push it below
 * the fold (measured live: the exact model ranked behind nine Razer cards).
 * The exact-identity tier only exists for queries that name a curated brand
 * AND a model token, so category and brand-only shelves keep the price order
 * byte-for-byte.
 */
export function rankPrimaryByEffective(
  products: readonly NormalizedProduct[],
  scope: CountryCode | null,
  query?: string,
): NormalizedProduct[] {
  const key = (p: NormalizedProduct): number | null => {
    const inMarket = scope === null
      ? p.offers
      : p.offers.filter((o) => !isCrossMarketOffer(o, scope));
    if (inMarket.length === 0) return null;
    return Math.min(...inMarket.map((o) => effectiveKwdOfOffer(o)));
  };
  const q = query ?? "";
  const hasExactIdentity = q !== "" && exactModelQuery(q) !== null;
  const exactRank = (p: NormalizedProduct): number =>
    hasExactIdentity && carriesExactModel(q, p.title) ? 0 : 1;
  return [...products].sort((a, b) => {
    const ea = exactRank(a);
    const eb = exactRank(b);
    if (ea !== eb) return ea - eb;
    const ka = key(a);
    const kb = key(b);
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1;
    if (kb == null) return -1;
    return ka - kb;
  });
}

/**
 * REEA-1178 AC1 — one card per productId: drop any repeat of an id already in
 * the set (the first occurrence is the highest-ranked card). Pure and
 * client-safe; shared by the renderer chain and the depth fold so the painted
 * shelf and the counted shelf stay one population.
 */
export function uniqueCardsByProductId(
  cards: readonly NormalizedProduct[],
): NormalizedProduct[] {
  const seen = new Set<string>();
  const out: NormalizedProduct[] = [];
  for (const card of cards) {
    if (seen.has(card.productId)) continue;
    seen.add(card.productId);
    out.push(card);
  }
  return out;
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

/**
 * REEA-1267 — the cards one page of a snapshot ACTUALLY paints, i.e. the same
 * cumulative flush chain the streamed renderer runs (StageAppend →
 * freshCardsForFlush) over a single settled snapshot. The shelf is budgeted
 * per query class (REEA-1207/REEA-1238), so "the confident in-scope set" is
 * NOT the whole primary partition: a card beyond the budget never reaches the
 * screen and must never be claimed as hidden. The hidden-match escape is
 * computed over this population so its count equals what the reveal adds.
 */
export function paintedShelfFromProducts(
  products: readonly NormalizedProduct[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): NormalizedProduct[] {
  const budget = shelfCardBudget(query);
  return freshCardsForFlush(
    shelfCardsFromProducts(products, query, page, country, showOutOfStock),
    new Set<string>(),
    false,
    budget,
    {
      comparisonFirst: true,
      finalFlush: true,
      singleTail: budget === CATEGORY_SHELF_CARDS ? 1 : 2,
    },
  );
}

/** Snapshot-level convenience wrapper over `shelfSectionsFromProducts`. */
export function resultsShelfSections(
  snap: { products: readonly NormalizedProduct[] },
  query: string,
  country: CountryCode | null,
  showOutOfStock: boolean,
): ShelfSections {
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
/**
 * REEA-1207 AC 7B-1/7B-2 — the shelf budget for this query. A category or
 * brand-only query is a COMPARISON surface: it stops at the category budget
 * (comparisons lead), so a long stream of single-retailer appends cannot bury
 * the comparison cards the shopper came for. An exact-model query keeps the
 * wider page (REEA-1175 measured those as already deep).
 */
export function shelfCardBudget(query: string): number {
  return modelIdentityTokens(query).length > 0 ? RESULTS_PAGE_SIZE : CATEGORY_SHELF_CARDS;
}

/** REEA-1207 — the category shelf budget (cards painted for one query). */
export const CATEGORY_SHELF_CARDS = 6;

/** REEA-1238 — how the streamed paint chain may spend a category shelf's
 *  slots. The category shelf is a COMPARISON surface (REEA-1207 AC 7B-1R):
 *  an intermediate flush may only claim slots with comparison cards, so the
 *  singles that answer first cannot consume the budget before the
 *  cross-retailer merge exists. The final flush then spends whatever is left
 *  on the comparison-led shelf (comparisons first, then the two singles the
 *  shelf is allowed). Exact-model shelves keep the pre-change append rule. */
export interface FlushPaintOptions {
  /** True for a comparison-led shelf. */
  comparisonFirst?: boolean;
  /** True for the LAST stage of the run (the settled/finalized snapshot). */
  finalFlush?: boolean;
  /** REEA-1238 — how many non-comparison cards the final flush may paint.
   *  The category snapshot already caps its own single tail; this keeps the
   *  wider exact-model page from drowning its comparison cards in filler. */
  singleTail?: number;
  /**
   * REEA-1275 — a LEAD flush (the exact-model seed card) may paint its
   * single-retailer card even though it is not the final stage: the shopper
   * asked for THIS model, and the cross-retailer merge it would otherwise wait
   * for may never land inside the completion budget. It never claims the
   * Best-price badge (the renderer decides that), and later live stages fold
   * the same seed idempotently, so a live answer supersedes the lead.
   */
  leadFlush?: boolean;
  /**
   * REEA-1275 — how many single-retailer cards a WIDER exact-model shelf may
   * paint in an intermediate flush (0 on the category shelf, which keeps the
   * REEA-1238 comparison-only rule). Without this, an exact-model query whose
   * first adapter answers with a single had to wait for a second merchant to
   * merge before ANY card could paint; measured on the served head, that wait
   * is most of the first-card budget. The remaining slots stay reserved for
   * comparisons, and the converged view supersedes the early single with the
   * merged card once the live answer lands.
   */
  earlySingles?: number;
}

export function freshCardsForFlush(
  visible: readonly NormalizedProduct[],
  paintedIds: ReadonlySet<string>,
  replay: boolean,
  budget: number = RESULTS_PAGE_SIZE,
  opts: FlushPaintOptions = {},
): NormalizedProduct[] {
  if (replay) return [];
  // The budget is CUMULATIVE: later flushes only fill the slots the page has
  // left, so the served shelf cannot grow past the budget through appends.
  const remaining = Math.max(0, budget - paintedIds.size);
  if (remaining === 0) return [];
  const fresh: NormalizedProduct[] = [];
  // REEA-1238 — a category shelf's intermediate flush is COMPARISON-ONLY.
  // Live evidence: the first flushes painted the six cheapest single-retailer
  // cards (an early-answering lane's rows), the budget was exhausted, and the
  // final snapshot's merged comparison cards could never paint — the served
  // page read as a directory even though the run had produced comparisons.
  // Reserving every remaining slot for comparison cards until the final flush
  // makes the painted shelf track the merge instead of the arrival order.
  // The final flush paints the full comparison-led shelf, so a query with no
  // comparison still fills its ordinary category page. The comparison cards
  // paint before the singles in BOTH cases: the price-ranked `visible` order
  // (REEA-1177 AC 6a-4) would otherwise put a cheap single ahead of the
  // comparison card the category surface exists to show.
  // REEA-1275 — the seed LEAD flush is the one deliberate exception: its
  // single exact-model card paints immediately, because waiting for a merge
  // that may never come is exactly the first-card latency this ticket fixes.
  // A wider exact-model shelf also gets a bounded early-singles window
  // (`earlySingles`) for the same reason; the category shelf keeps the
  // comparison-only rule.
  const comparisonFirst = opts.comparisonFirst === true;
  const finalFlush = opts.finalFlush === true;
  const leadFlush = opts.leadFlush === true;
  const earlySingles = Math.max(0, opts.earlySingles ?? 0);
  const comparisonOnly = comparisonFirst && !finalFlush && !leadFlush && earlySingles === 0;
  const singleTail = opts.singleTail ?? Number.POSITIVE_INFINITY;
  // REEA-1238 — a card carrying two distinct retailers across the fetched set
  // (including a cross-market pair such as Danube Home + BinSina) is a
  // comparison card for paint purposes; the card's data-comparison-kw still
  // reports the Kuwait-only basis the depth gate reads.
  const isComparison = (p: NormalizedProduct): boolean =>
    comparisonMerchantCount(p.offers, null) >= 2;
  const comparisonCards = comparisonFirst ? visible.filter(isComparison) : [];
  const ordered = comparisonFirst
    ? [...comparisonCards, ...visible.filter((p) => !isComparison(p))]
    : visible;
  // The bounded single tail only exists to stop a comparison-rich page being
  // drowned by filler. A page with no comparison at all keeps its ordinary
  // wider shelf (six category cards, or the exact-model page) — capping it to
  // one/two singles would turn a thin comparison shelf into a near-empty one.
  const hasComparison = comparisonCards.length > 0;
  let singlesPainted = 0;
  for (const p of ordered) {
    if (paintedIds.has(p.productId)) continue;
    const comparison = isComparison(p);
    if (comparisonOnly && !comparison) continue;
    if (comparisonFirst && !comparisonOnly && !comparison) {
      if (!finalFlush && !leadFlush) {
        // REEA-1275 — the bounded early-singles window of a wider exact-model
        // shelf: enough for the first card to paint, while the rest of the
        // budget stays reserved for the cross-retailer merge.
        if (singlesPainted >= earlySingles) continue;
        singlesPainted += 1;
      } else if (hasComparison) {
        if (singlesPainted >= singleTail) continue;
        singlesPainted += 1;
      }
    }
    fresh.push(p);
    if (fresh.length >= remaining) break;
  }
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
 * always wins; an equal-offer answer wins when it is STRICTLY more merged
 * (fewer cards), so the settled, deduped shelf replaces the provisional one.
 * A poorer answer never replaces what is already rendered, and an exact
 * evidence tie keeps the rendered shelf.
 *
 * REEA-1154 / D4 — the tie must keep the rendered shelf. Two spellings of one
 * dispatched query are served the same memo answer, but a stale-window repeat
 * re-runs the fan-out: that sibling run can carry the SAME card and offer
 * totals with one different listing (QA measured the AR spelling swapping an
 * Amazon case). Swapping on the tie made two spellings of the same query
 * render different sets, so equal evidence now keeps what is on screen.
 * ------------------------------------------------------------------------- */

/** Total offer rows a snapshot's products carry — the comparison evidence. */
export function snapshotOfferTotal(products: readonly NormalizedProduct[]): number {
  let total = 0;
  for (const p of products) total += p.offers?.length ?? 0;
  return total;
}

/**
 * Pick the snapshot to render when a late/converged answer arrives: the one
 * with more offer evidence, else the equally-rich answer that is strictly more
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
  if (incomingOffers === currentOffers && incoming.products.length < current.products.length) {
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
  stages: readonly Promise<{ products: readonly NormalizedProduct[]; replay?: boolean; seedLead?: boolean }>[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): Promise<NormalizedProduct[]> {
  let paintedIds: ReadonlySet<string> = new Set<string>();
  const painted: NormalizedProduct[] = [];
  const budget = shelfCardBudget(query);
  // REEA-1238 — comparison-first for every query class: the intermediate
  // flush paints comparison cards only, so an early single cannot claim the
  // slot a later merged comparison needs (they share the productId once the
  // merge lands). The final flush paints the comparison-led page plus a
  // bounded single tail (one on a category shelf, two on the wider
  // exact-model page) so the comparisons cannot be drowned by filler.
  // REEA-1275 — the seed LEAD flush is the one documented exception; this
  // fold MUST apply the same policy the renderer does or the counters
  // describe a different population than the page painted.
  const comparisonFirst = true;
  const singleTail = budget === CATEGORY_SHELF_CARDS ? 1 : 2;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    let snap: { products: readonly NormalizedProduct[]; replay?: boolean; seedLead?: boolean } | null;
    try {
      // REEA-1068 D1 — adopt through Promise.resolve so React thenables (SSR
      // prop shape) and plain promises both work here, exactly like the
      // renderer's union helper.
      snap = await Promise.resolve(stage);
    } catch {
      snap = null;
    }
    if (!snap) continue;
    // REEA-1238 — the SAME flush policy the renderer applies: a category
    // shelf's intermediate flushes only paint comparison cards, so the fold
    // can never describe a different population than the page painted.
    const fresh = freshCardsForFlush(
      resultsShelfCards(snap, query, page, country, showOutOfStock),
      paintedIds,
      snap.replay === true,
      budget,
      {
        comparisonFirst,
        finalFlush: index === stages.length - 1,
        singleTail,
        leadFlush: snap.seedLead === true,
        earlySingles: budget === CATEGORY_SHELF_CARDS ? 0 : 1,
      },
    );
    painted.push(...fresh);
    paintedIds = paintedIdsAfter(paintedIds, fresh);
  }
  return painted;
}

/**
 * REEA-1275 — trim the streamed stage snapshots to the cards each flush
 * ACTUALLY paints.
 *
 * Why: the served document serializes every stage's full cumulative snapshot
 * for hydration, and each cumulative snapshot repeats the products earlier
 * flushes already painted. Measured on the served head, a cold `iphone 17
 * pro` document carried ~600 KB of RSC payload for a 7-card shelf, and the
 * browser had to download/parse it before the first card could paint — the
 * client half of the miss this ticket fixes.
 *
 * The paint chain is deterministic and server-side (the same
 * `freshCardsForFlush` the renderer and the metrics fold use), so an
 * intermediate stage can carry ONLY the cards it paints. The LAST stage stays
 * full: the converged view, the coverage/stamp boundaries and the structured
 * data all read it. A replay paints nothing, so its products are dropped
 * entirely. A rejected stage passes through untouched (the honest "nothing
 * landed" state), exactly as before.
 *
 * The payload shape is unchanged otherwise (`replay`/`seedLead`/`settled`/
 * `kuwaitPendingStatus` ride along), so hydration, the paint chain and the
 * counters describe the same population they did before.
 */
export function trimStagesToPaintedDiff(
  stages: readonly Promise<LiveSearchResult>[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): Promise<LiveSearchResult>[] {
  // The page slice is applied by the renderer over a snapshot's PRIMARY set;
  // a trimmed snapshot no longer carries the earlier pages, so page 2+ keeps
  // the full snapshots (the measured first-card surface is page 1).
  if (page !== 1) return [...stages];
  const budget = shelfCardBudget(query);
  const singleTail = budget === CATEGORY_SHELF_CARDS ? 1 : 2;
  const earlySingles = budget === CATEGORY_SHELF_CARDS ? 0 : 1;
  let paintedIds: ReadonlySet<string> = new Set<string>();
  // The renderer paints the boundaries in ARRAY order (each boundary renders
  // inside the previous one), so the cumulative painted set must be computed
  // in that same order even when a later adapter promise happens to settle
  // first. Chain the stages instead of relying on settlement order.
  let gate: Promise<void> = Promise.resolve();
  return stages.map((stage, index) => {
    const isLast = index === stages.length - 1;
    const trimmed = gate.then(() => stage).then(
      (snap) => {
        if (isLast) return snap;
        // A replay paints nothing; its products are superseded by the live
        // stages, so the payload carries none of them.
        if (snap.replay === true) return { ...snap, products: [], notes: [] };
        const earlierPainted = paintedIds;
        const fresh = freshCardsForFlush(
          resultsShelfCards(snap, query, page, country, showOutOfStock),
          earlierPainted,
          false,
          budget,
          {
            comparisonFirst: true,
            finalFlush: false,
            singleTail,
            leadFlush: snap.seedLead === true,
            earlySingles,
          },
        );
        paintedIds = paintedIdsAfter(earlierPainted, fresh);
        // Keep every product an EARLIER flush has not already painted: the
        // fresh cards this flush paints PLUS the rows the current
        // country/stock selection hides. The hidden rows must ride the stream
        // so the in-place "show all stock / all markets" reveal (REEA-291
        // AC4, REEA-1114) can still paint them without a refetch.
        // An intermediate flush never reads its own notes (the coverage line
        // reads the last stage), so dropping them is pure payload saving.
        return {
          ...snap,
          products: snap.products.filter((p) => !earlierPainted.has(p.productId)),
          notes: [],
        };
      },
      () => stage,
    );
    gate = trimmed.then(
      () => undefined,
      () => undefined,
    );
    return trimmed;
  });
}
