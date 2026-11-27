/**
 * REEA-1211 — paint a catalog identity's LAST VERIFIED OBSERVATION when its
 * live re-check lands nothing.
 *
 * A catalog seed carries an identity and a bundled offer row with no
 * collection stamp, so the PDP never inherits it (REEA-1192): the page paints
 * only what this request's live fan-out confirms. That is the right honesty
 * rule — a bundled price is not an observation — but it means a catalog
 * identity whose only listing is unreliable renders an empty offer table. The
 * measured case is keychron-v3-max: one amazon.eg search listing that answers
 * `HTTP 503` for long stretches, so the sitemap-advertised URL served
 * `<div class="rc-offers-table" aria-busy="true">` and zero rows in both
 * locales while the rest of the sitemap rendered.
 *
 * The store already keeps the last COMPLETED collection per product
 * (`findLastCompleted`, the same source the failed-run "last verified" client
 * fallback reads). Those rows carry their own `collectedAt`, so seeding them
 * onto the page keeps the honesty contract intact:
 *
 *  - every painted price names the moment it was observed ("Checked 55m ago"),
 *    never a bare bundled figure;
 *  - they are marked `method: "cache"`, so the status token reads "Needs
 *    verification" — collected from the retailer, not cross-checked in THIS
 *    run — instead of borrowing this run's "Verified" claim;
 *  - this page's live re-checks replace the rows they confirm through the
 *    existing REEA-1140/1192 merge (same merchant+listing), so a fresh answer
 *    always wins over the seeded one.
 *
 * Only observations inside the site's freshness window are painted (REEA-1168
 * AC-7): a row older than that emits no price claim, so the page keeps waiting
 * for this request's live fan-out instead of dressing a stale figure as the
 * answer.
 *
 * The same predicate is used by the sitemap (`/product/*` is advertised only
 * when the page would paint a row), so the advertised URL and the served page
 * cannot disagree about whether there is something to show.
 */
import type { LiveOffer } from "@/lib/collect/types";
import { findLastCompleted } from "@/lib/collect/store";
import {
  exactModelIdentityProduct,
  stampSeededCard,
} from "@/lib/exact-model-seed";
import { OFFER_STATUS_STALE_MS } from "@/lib/offer-status";
import type { NormalizedProduct } from "@/types/product";

/** True when this row carries the moment it was observed. */
export function hasCollectionStamp(offer: { collectedAt?: string }): boolean {
  return typeof offer.collectedAt === "string" && offer.collectedAt !== "";
}

/**
 * True when this row's own observation stamp is inside the site's freshness
 * window. REEA-1168 AC-7 — a row older than the window emits no price claim
 * (the status token reads "Stale"), so it is not painted as this page's answer
 * and the sitemap does not advertise a URL whose only evidence is that row.
 */
export function isFreshObservation(
  offer: { collectedAt?: string },
  nowMs: number,
): boolean {
  const observedAtMs = Date.parse(offer.collectedAt ?? "");
  return (
    Number.isFinite(observedAtMs) &&
    Math.max(0, nowMs - observedAtMs) <= OFFER_STATUS_STALE_MS
  );
}

/**
 * The last verified observation stored for this product that is still FRESH,
 * or `null`.
 *
 * Fail-open: a store read failure returns `null` so a page render never fails
 * on the fallback lookup (the live fan-out still runs).
 */
export async function lastVerifiedObservation(
  productId: string,
  nowMs: number = Date.now(),
): Promise<LiveOffer[] | null> {
  let last;
  try {
    last = await findLastCompleted(productId);
  } catch {
    return null;
  }
  const offers = (last?.offers ?? []).filter(
    (offer) => hasCollectionStamp(offer) && isFreshObservation(offer, nowMs),
  );
  return offers.length > 0 ? offers : null;
}

/**
 * Seed a catalog identity's page with its last verified observation.
 *
 * Returns the product untouched when:
 *  - it already carries stamped rows (the shelf's query-time evidence is the
 *    fresher, exact answer this visit was reached from — REEA-1140);
 *  - no completed collection with offers is stored for it (the page must then
 *    wait for this request's live fan-out, and the sitemap must not list it).
 */
export async function seedCatalogPageWithLastObservation(
  product: NormalizedProduct,
): Promise<NormalizedProduct> {
  if ((product.offers ?? []).some(hasCollectionStamp)) return product;
  const offers = await lastVerifiedObservation(product.productId);
  if (!offers) return product;
  // A stored observation is evidence from an EARLIER run: label it as such so
  // the row cannot claim this run's cross-check.
  const replayed = offers.map((offer) => ({ ...offer, method: "cache" as const }));
  return { ...product, offers: replayed as unknown as NormalizedProduct["offers"] };
}

/**
 * REEA-1261 AC-1/AC-2 — the exact-model shelf card for a brand+model query.
 *
 * Same evidence and the same honesty rules as the PDP seed above: the catalog
 * supplies the identity, the shared store supplies the last COMPLETED live
 * observation (rows with their own `collectedAt`, marked `cache` so the card
 * reads "Needs verification"), and nothing is painted when no fresh
 * observation exists. Returns null for category/brand-only/model-only
 * queries, so their shelves are untouched.
 *
 * Fail-open: a store read failure returns null and the live fan-out's answer
 * stands — the seed can never blank or fail a search.
 */
export async function exactModelShelfSeed(
  query: string,
  nowMs: number = Date.now(),
): Promise<NormalizedProduct | null> {
  const identity = exactModelIdentityProduct(query);
  if (!identity) return null;
  const offers = await lastVerifiedObservation(identity.productId, nowMs);
  if (!offers) return null;
  const replayed = offers.map((offer) => ({ ...offer, method: "cache" as const }));
  return stampSeededCard(query, {
    ...identity,
    offers: replayed as unknown as NormalizedProduct["offers"],
  });
}
