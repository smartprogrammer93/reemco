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
 * The same predicate is used by the sitemap (`/product/*` is advertised only
 * when the page would paint a row), so the advertised URL and the served page
 * cannot disagree about whether there is something to show.
 */
import type { LiveOffer } from "@/lib/collect/types";
import { findLastCompleted } from "@/lib/collect/store";
import type { NormalizedProduct } from "@/types/product";

/** True when this row carries the moment it was observed. */
export function hasCollectionStamp(offer: { collectedAt?: string }): boolean {
  return typeof offer.collectedAt === "string" && offer.collectedAt !== "";
}

/**
 * The last verified observation stored for this product, or `null`.
 *
 * Fail-open: a store read failure returns `null` so a page render never fails
 * on the fallback lookup (the live fan-out still runs).
 */
export async function lastVerifiedObservation(
  productId: string,
): Promise<LiveOffer[] | null> {
  let last;
  try {
    last = await findLastCompleted(productId);
  } catch {
    return null;
  }
  const offers = (last?.offers ?? []).filter(hasCollectionStamp);
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
