import { PRODUCTS } from "@/lib/feed";
import {
  canonicalFields,
  compatibleFields,
  storageFromListingUrl,
  type CanonicalFields,
} from "@/lib/collect/canonical-product";
// REEA-1078 S2 — dead-lane retirement for the detail page's live resolution.
import { readRetiredLanes } from "@/lib/collect/lane-health";
// REEA-1246 AC5 — a live slug that folds onto a catalog identity is the same
// SKU, so its bare visit must dispatch the same phrase the sitemap URL uses.
import { canonicalProductIdForSlug } from "@/lib/product-canonical";
// REEA-1269 — the sitemap's source-query hint for a live-only product key.
import { readPdpSource } from "@/lib/pdp-source";
import type { CountryCode } from "@/lib/country";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-114 — resolve a product identity for follow-through pages
 * (/product/[id], collection routes). Catalog ids win first; ids produced by
 * the LIVE query-time collector are resolved against the same live fan-out, so
 * result → detail → retailer links stay on one consistent live path.
 * REEA-170 — the optional country selection scopes the live resolution to the
 * adapters tagged for that country, keeping detail-page figures on the same
 * filtered offer set as the results list that linked here.
 *
 * REEA-1140 — card → "View all" continuity. The results card now carries the
 * query it was collected for (`?q=`), and the PDP resolves that SAME query
 * instead of decoding the slug into a different search phrase. Both surfaces
 * then run the same live fan-out and the same merge map, and the product is
 * selected by its canonical SKU slug — never by "the first compatible row".
 * That is what stops a 5-offer merged card from landing on a 1-retailer PDP,
 * and a 512 GB card from rendering the 256 GB group.
 *
 * REEA-437 — moved out of feed.ts so the browser-safe facade (PRODUCTS,
 * filterProducts) no longer carries the live-collector hop into client
 * bundles: the results shell imports PRODUCTS only, and this server-only
 * resolution lives one import away. Behavior unchanged.
 */
export async function resolveProductIdentity(
  productId: string,
  country?: CountryCode | null,
  query?: string | null,
): Promise<NormalizedProduct | null> {
  const seeded = PRODUCTS.find((p) => p.productId === productId);
  // REEA-1246 AC5 — a catalog identity is an IDENTITY, not a price source.
  // The old short-circuit returned the bundled catalog row (one or two
  // listings with no collection stamp), so the sitemap-advertised URL
  // `/product/iphone-17-pro` painted a thin 1-retailer page while the shelf's
  // canonical key (`apple-iphone17-pro-256gb`) carried six. Resolve the same
  // live fan-out here and fold the catalog id onto the live group that names
  // the same SKU, so both keys render one offer set. The catalog row stays the
  // fallback when no live group answers (the page's own per-listing re-check
  // then paints whatever the retailer still serves).
  if (seeded) {
    const live = await resolveSeededIdentity(seeded, country, query);
    return live ?? seeded;
  }

  const carriedQuery = (query ?? "").trim();
  // REEA-1246 AC5 — a live slug that folds onto a catalog identity is the SAME
  // SKU as the sitemap URL, so a bare visit must resolve through the same
  // phrase the catalog page uses. Without this, `/product/apple-iphone17-pro-
  // 256gb` (no ?q=) dispatched "apple iphone17 pro 256gb", missed the shelf
  // memo and painted 5 last-seen retailers while `/product/iphone-17-pro`
  // served the shelf's 6. The exact productId lookup below still selects the
  // live group; only the dispatch phrase is unified.
  //
  // The canonical-match fields stay on the SLUG's own phrase (REEA-1140): the
  // catalog phrase may be less specific (e.g. no storage tier), so folding it
  // into `want` would let a 256 GB slug accept a 512 GB group on a tie.
  const slugPhrase = productId.replace(/[-_]+/g, " ").trim();
  const catalogId = canonicalProductIdForSlug(productId);
  const decodedQuery =
    catalogId !== productId
      ? catalogId.replace(/-/g, " ").trim()
      : slugPhrase;
  if (!carriedQuery && !decodedQuery) return null;

  const {
    readLiveQueryMemo,
    collectLiveResultsStagedAdmitted,
    RESULTS_COMPLETION_BUDGET_MS,
    STAGE_TAIL_HEADROOM_MS,
  } = await import("@/lib/collect/live-search");
  const retiredLanes = await readRetiredLanes();
  // REEA-1269 — a bare-slug visit has no carried query, so the dispatch phrase
  // was the slug itself, and that phrase is not always what the retailers
  // answer for (measured: sitemap-advertised long-tail keys served
  // `<div class="rc-offers-table" aria-busy="true">` with zero rows, while the
  // same URL with the source query painted the shelf's offers). The sitemap's
  // inventory fold persists the query that minted each live-only key
  // (lib/pdp-source.ts); dispatching it reproduces the shelf's own run, so the
  // advertised URL renders the offer set the sitemap promised (S-2).
  const sourceQuery = carriedQuery ? null : await readPdpSource(productId);

  // REEA-1140 — a carried query must reproduce the results page's fan-out.
  // The results page collects the whole market set and applies the country
  // selection as a render-time filter; scoping the adapters here would drop
  // offers the card counted. Only a slug-only visit (no carried query) keeps
  // the REEA-170 country scoping. REEA-1269: a source-query hint IS a shelf
  // query, so it keeps the unscoped fan-out too.
  const scopeCountry = carriedQuery || sourceQuery ? null : country ?? null;

  const attempts = [
    ...new Set([carriedQuery, sourceQuery ?? "", decodedQuery].filter((q) => q !== "")),
  ];
  let fallbackPool: NormalizedProduct[] = [];
  for (const attempt of attempts) {
    // REEA-1192 — collection continuity: when the shelf just served this same
    // query, its answer is already in the query memo (live fan-out answers
    // only, with their own scrapedAt provenance). Inheriting it gives the PDP
    // the EXACT offer set, freshness and merge map the shopper clicked, with
    // no second 22-lane fan-out and no chance of resolving against a
    // different map than the card served.
    const memo = readLiveQueryMemo(attempt, {
      country: scopeCountry,
      // REEA-1078 S2 — the product page's live answer skips retired lanes too.
      retiredLanes,
    });
    if (memo) {
      // REEA-1140 — exact canonical-slug match first: the same merge map that
      // produced the card's link produces this group's productId.
      const exact = memo.products.find((p) => p.productId === productId);
      if (exact) return exact;
      if (fallbackPool.length === 0) fallbackPool = memo.products;
    }
    // REEA-1192 — no inherited answer (a cold visit: sitemap, shared link,
    // first request after a restart). Dispatch the same query through the
    // REEA-1133 page-path admission gate and bound the wait to the page
    // completion budget instead of the 16 s blocking ceiling, so the PDP's
    // cold render stays inside the shelf's budget without raising the
    // fan-out bound.
    const staged = await collectLiveResultsStagedAdmitted(attempt, {
      country: scopeCountry,
      retiredLanes,
      deadlineMs: RESULTS_COMPLETION_BUDGET_MS,
      signal: AbortSignal.timeout(RESULTS_COMPLETION_BUDGET_MS + STAGE_TAIL_HEADROOM_MS),
    });
    let { products } = await staged.final;
    if (products.length === 0) {
      // Capacity-deferred shell (or a budget-finalized empty set): take the
      // run's converged answer, already bounded by the same hop ceiling.
      products = (await staged.converged).products;
    }
    const exact = products.find((p) => p.productId === productId);
    if (exact) return exact;
    // REEA-1192 — a card->PDP click can arrive while the shelf's finalize
    // write is still in flight (the results page streams its first stage; the
    // memo is written on the FINAL stage). Wait, bounded to 2 s, for that
    // memo to land and carry the exact slug, so the PDP resolves the SAME
    // merge map the card was rendered from instead of a second fan-out that
    // answered differently (measured: hp-probook4 landed on the HP OMEN
    // group, philips-5000s on Quadra Stores, Fold7-256 lost Blink).
    const memoDeadline = Date.now() + 2_000;
    while (Date.now() < memoDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const late = readLiveQueryMemo(attempt, { country: scopeCountry, retiredLanes });
      if (!late) continue;
      const lateExact = late.products.find((p) => p.productId === productId);
      if (lateExact) return lateExact;
      if (fallbackPool.length === 0) fallbackPool = late.products;
    }
    if (fallbackPool.length === 0) fallbackPool = products;
    // REEA-1192 — the bounded page snapshot can legitimately miss a card whose
    // lane had not answered yet (measured: philips-5000s resolved to an Xcite
    // 2.90 neighbour, sony-wh-1000xm6-over to a Eureka 94.95 one). Falling
    // back to a canonical neighbour there is the old wrong-product defect, so
    // wait for the run's converged answer (bounded by the same hop ceiling)
    // and only then accept a neighbour.
    if (!fallbackPool.some((p) => p.productId === productId)) {
      const converged = await staged.converged;
      const convergedExact = converged.products.find((p) => p.productId === productId);
      if (convergedExact) return convergedExact;
      if (fallbackPool.length === 0) fallbackPool = converged.products;
    }
  }

  // REEA-1140 — legacy / alias slugs (and a collection whose fetched set moved
  // the canonical slug): match the requested slug's canonical fields against
  // the live groups, preferring the candidate that names the same storage tier
  // over a partial-field neighbour. This is what keeps an old
  // `…-512phone-black` link on the 512 GB group instead of the 256 GB one.
  const want = canonicalFields(slugPhrase);
  const best = bestCanonicalMatch(fallbackPool, want);
  return best ?? fallbackPool[0] ?? null;
}

/** How long a catalog identity waits for a slow lane to converge before it
 *  settles for the finalized snapshot or the catalog fallback. */
const SEEDED_CONVERGED_WAIT_MS = 2_000;

function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * REEA-1246 AC5 — resolve a catalog identity through the SAME live fan-out the
 * shelf runs, then fold it onto the live group whose canonical fields name the
 * same SKU. The returned product keeps the catalog id (the URL/canonical
 * identity) but carries the live offer set, so `/product/iphone-17-pro` and
 * `/product/apple-iphone17-pro-256gb` render one offer set instead of a thin
 * duplicate page. Returns null when no live group answers — the caller then
 * keeps the catalog row (and the page's per-listing re-check paints what the
 * retailer still serves).
 *
 * One fan-out, bounded: the shelf's memo when this query was just served, else
 * one admitted staged run. A cold catalog visit pays at most the completion
 * budget plus a short converge window, never the whole hop ceiling.
 */
async function resolveSeededIdentity(
  seeded: NormalizedProduct,
  country: CountryCode | null | undefined,
  query: string | null | undefined,
): Promise<NormalizedProduct | null> {
  const carriedQuery = (query ?? "").trim();
  // The decoded slug is the merge identity's own phrase (the same query shape
  // the live key decodes to), so it reproduces the shelf fan-out that minted
  // the group; a carried shelf query wins because it is the exact one served.
  const decodedQuery = seeded.productId.replace(/[-_]+/g, " ").trim();
  const attempt = carriedQuery || decodedQuery;
  if (attempt === "") return null;
  const {
    readLiveQueryMemo,
    collectLiveResultsStagedAdmitted,
    RESULTS_COMPLETION_BUDGET_MS,
    STAGE_TAIL_HEADROOM_MS,
  } = await import("@/lib/collect/live-search");
  const retiredLanes = await readRetiredLanes();
  const scopeCountry = carriedQuery ? null : country ?? null;
  const want = canonicalFields(seeded.title);
  // A key with neither model line nor storage is too generic to fold onto a
  // live group; keep the catalog identity and its own re-check.
  if (want.modelLine === "" && want.storage === "") return null;

  const memo = readLiveQueryMemo(attempt, { country: scopeCountry, retiredLanes });
  if (memo) {
    const best = bestCanonicalMatch(memo.products, want);
    if (best) return withCatalogId(best, seeded.productId);
  }

  const staged = await collectLiveResultsStagedAdmitted(attempt, {
    country: scopeCountry,
    retiredLanes,
    deadlineMs: RESULTS_COMPLETION_BUDGET_MS,
    signal: AbortSignal.timeout(RESULTS_COMPLETION_BUDGET_MS + STAGE_TAIL_HEADROOM_MS),
  });
  const { products } = await staged.final;
  const finalBest = bestCanonicalMatch(products, want);
  if (finalBest) return withCatalogId(finalBest, seeded.productId);
  // The finalized snapshot is bounded by the completion budget; a lane that
  // answers just after it can still hold the group. Wait briefly, then fall
  // back to the catalog row rather than blocking first paint on the ceiling.
  const converged = await withinMs(staged.converged, SEEDED_CONVERGED_WAIT_MS);
  const convergedBest = converged ? bestCanonicalMatch(converged.products, want) : null;
  return convergedBest ? withCatalogId(convergedBest, seeded.productId) : null;
}

/** Keep the catalog URL identity while carrying the live group's offer set.
 *  Curated catalog extras fill only the arrays the live group left empty. */
function withCatalogId(
  live: NormalizedProduct,
  catalogId: string,
): NormalizedProduct {
  const seeded = PRODUCTS.find((p) => p.productId === catalogId);
  const image = live.image ?? seeded?.image;
  return {
    ...live,
    productId: catalogId,
    ...(image ? { image } : {}),
    coupons: live.coupons?.length ? live.coupons : seeded?.coupons ?? [],
    variations: live.variations?.length ? live.variations : seeded?.variations ?? [],
    alternatives: live.alternatives?.length ? live.alternatives : seeded?.alternatives ?? [],
    ...(live.pairsWith?.length || seeded?.pairsWith?.length
      ? { pairsWith: live.pairsWith?.length ? live.pairsWith : seeded?.pairsWith ?? [] }
      : {}),
  };
}

/** Live fields of a candidate product, with the capacity filled from its own
 *  listing URLs when the scraped title omits it (same rule the merge identity
 *  uses). Never mutates the shared field cache. */
function candidateFields(product: NormalizedProduct): CanonicalFields {
  const fields = canonicalFields(product.title);
  if (fields.storage) return fields;
  for (const offer of product.offers) {
    const fromUrl = storageFromListingUrl(offer.url);
    if (fromUrl) return { ...fields, storage: fromUrl };
  }
  return fields;
}

/**
 * REEA-1140 — deterministic best canonical match for a requested slug. A
 * candidate must be field-compatible; among compatible candidates the one that
 * agrees on the requested storage tier wins over one that only agrees
 * partially (the bug that rendered a 512 GB PDP with the 256 GB title). Ties
 * break on productId so the same fetched set always resolves identically.
 */
function bestCanonicalMatch(
  products: readonly NormalizedProduct[],
  want: CanonicalFields,
): NormalizedProduct | null {
  let best: NormalizedProduct | null = null;
  let bestScore = -Infinity;
  for (const product of products) {
    const fields = candidateFields(product);
    if (!compatibleFields(want, fields)) continue;
    let score = 0;
    // REEA-1162 — a requested slug that names the platform prefers the live
    // group whose own titles name the SAME platform, so a PS4/PS5 sibling
    // never wins the resolution for the other tier.
    if (want.platform && fields.platform === want.platform) score += 6;
    if (want.storage && fields.storage === want.storage) score += 8;
    else if (want.storage && fields.storage === "") score -= 1;
    else if (!want.storage && fields.storage === "") score += 3;
    if (want.modelLine && fields.modelLine === want.modelLine) score += 4;
    if (want.color && fields.color === want.color) score += 2;
    if (want.brand && fields.brand === want.brand) score += 1;
    if (want.grade !== "new" && fields.grade === want.grade) score += 1;
    if (
      score > bestScore ||
      (score === bestScore && (best === null || product.productId < best.productId))
    ) {
      best = product;
      bestScore = score;
    }
  }
  return best;
}
