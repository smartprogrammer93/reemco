import { PRODUCTS } from "@/lib/feed";
import {
  canonicalFields,
  compatibleFields,
  storageFromListingUrl,
  type CanonicalFields,
} from "@/lib/collect/canonical-product";
// REEA-1078 S2 — dead-lane retirement for the detail page's live resolution.
import { readRetiredLanes } from "@/lib/collect/lane-health";
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
  if (seeded) return seeded;

  const carriedQuery = (query ?? "").trim();
  const decodedQuery = productId.replace(/-/g, " ").trim();
  if (!carriedQuery && !decodedQuery) return null;

  const {
    readLiveQueryMemo,
    collectLiveResultsStagedAdmitted,
    RESULTS_COMPLETION_BUDGET_MS,
    STAGE_TAIL_HEADROOM_MS,
  } = await import("@/lib/collect/live-search");
  const retiredLanes = await readRetiredLanes();
  // REEA-1140 — a carried query must reproduce the results page's fan-out.
  // The results page collects the whole market set and applies the country
  // selection as a render-time filter; scoping the adapters here would drop
  // offers the card counted. Only a slug-only visit (no carried query) keeps
  // the REEA-170 country scoping.
  const scopeCountry = carriedQuery ? null : country ?? null;

  const attempts = [...new Set([carriedQuery, decodedQuery].filter((q) => q !== ""))];
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
    // write is still in flight. Re-read the memo once, briefly, so the PDP
    // lands on the card's exact group instead of a canonical neighbour
    // (measured: hp-probook4 resolved to the HP OMEN card's group, and
    // philips-5000s to Quadra Stores, when the first lookup raced the write).
    await new Promise((resolve) => setTimeout(resolve, 150));
    const late = readLiveQueryMemo(attempt, { country: scopeCountry, retiredLanes });
    if (late) {
      const lateExact = late.products.find((p) => p.productId === productId);
      if (lateExact) return lateExact;
      if (fallbackPool.length === 0) fallbackPool = late.products;
    }
    if (fallbackPool.length === 0) fallbackPool = products;
  }

  // REEA-1140 — legacy / alias slugs (and a collection whose fetched set moved
  // the canonical slug): match the requested slug's canonical fields against
  // the live groups, preferring the candidate that names the same storage tier
  // over a partial-field neighbour. This is what keeps an old
  // `…-512phone-black` link on the 512 GB group instead of the 256 GB one.
  const want = canonicalFields(decodedQuery);
  const best = bestCanonicalMatch(fallbackPool, want);
  return best ?? fallbackPool[0] ?? null;
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
