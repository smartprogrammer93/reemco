/**
 * REEA-186 — in-stock-only search results by default, with an opt-in toggle
 * ("Show out-of-stock items") on the search-results surface.
 *
 * Same shared contract as the REEA-170 country filter, one rule per surface:
 *  - the server filters the live offer set right after collection and BEFORE
 *    pagination, so counts, best-price flags, retailer counts and cheaper
 *    alternatives are all computed from the visible offer set;
 *  - the client re-applies the same pass idempotently on the server-served
 *    data and in full on the static-host catalog fallback.
 *
 * Semantics chosen for "items known to be out of stock":
 *  - offer rows with `inStock === false` are hidden by default; with the
 *    toggle enabled every offer row shows again;
 *  - a product card whose offers are ALL out of stock disappears with them
 *    (no empty card is left behind);
 *  - offers without a stock signal stay visible — only a KNOWN out-of-stock
 *    is hidden, so missing availability data never silently drops a listing.
 *
 * The toggle rides the URL (`/results?q=…&oos=1`) exactly like the country
 * selection: the ACTIVE choice is a link target, every derived figure
 * re-collects live under it, and the same-tab remembered preference lives in
 * a module-level slot (REEA-84 pattern) so a new search from the header form
 * carries it without re-selecting. No cookies / localStorage / cross-session
 * ids. Product pages are NOT touched by this filter: the detail view keeps
 * showing in-stock and out-of-stock options together (spec §"Product page").
 *
 * Offers always come from the live per-retailer adapters; this module only
 * selects among what was just fetched — never a bundled catalog.
 */
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/**
 * Allowlisted normalize of the `?oos=` search param. Checked ⇔ "1"/"true";
 * unchecked ⇔ ""/"0"/"false" (an unchecked hidden field submits an empty
 * value); unset → null so the next fallback in the resolution chain applies.
 */
export function sanitizeShowOutOfStock(raw: unknown): boolean | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "" || v === "0" || v === "false") return false;
  return null;
}

/** True unless the listing is KNOWN out of stock (missing signal stays). */
export function offerIsVisible(o: Pick<PriceOffer, "inStock">): boolean {
  return o.inStock !== false;
}

/** Visible offers under the selection, order preserved. */
export function filterOffersByStock<T extends Pick<PriceOffer, "inStock">>(
  offers: T[],
  showOutOfStock: boolean,
): T[] {
  if (showOutOfStock) return offers;
  return offers.filter(offerIsVisible);
}

/**
 * Apply the selection to a normalized-product list. With the toggle enabled
 * this is a no-op passthrough; otherwise out-of-stock offer rows are dropped,
 * cards left with no visible offer are dropped too, and alternative
 * `fromPrice` figures are recomputed from the visible offers of the referenced
 * product (alternatives with no visible offer are dropped). On the server path
 * this runs after the server's identical pass, so it is idempotent there and
 * is the whole filter on the static-host catalog fallback.
 */
export function filterProductsByStock(
  products: NormalizedProduct[],
  showOutOfStock: boolean,
): NormalizedProduct[] {
  if (showOutOfStock) return products;
  const out: NormalizedProduct[] = [];
  for (const p of products) {
    const offers = filterOffersByStock(p.offers, false);
    if (offers.length === 0) continue;
    const alternatives = p.alternatives.flatMap((a) => {
      const alt = products.find((x) => x.productId === a.productId);
      if (!alt) return [a];
      const altOffers = filterOffersByStock(alt.offers, false);
      if (altOffers.length === 0) return [];
      return [{ ...a, fromPrice: Math.min(...altOffers.map((o) => o.price)) }];
    });
    out.push({ ...p, offers, alternatives });
  }
  return out;
}

/**
 * REEA-213 — which card in a FINAL sorted list carries the single "Best
 * price" badge: the first card that has at least one in-stock offer; when no
 * card in the list is stocked, the first card. Callers compute it per
 * rendered block (Devices container, plain list) so the badge never scans
 * past the top block — cheaper lower-tier cards cannot steal it.
 */
export function bestBadgeIndex(products: readonly NormalizedProduct[]): number {
  const i = products.findIndex((p) => p.offers.some((o) => o.inStock));
  if (i >= 0) return i;
  return products.length > 0 ? 0 : -1;
}

/* ---- Same-tab remembered selection (existing module-slot pattern). ---- */
let rememberedShowOutOfStock: boolean | null = null;

/** Toggle clicks record the choice for the next search's hidden input. */
export function rememberShowOutOfStock(value: boolean | null): void {
  rememberedShowOutOfStock = value;
}

export function recallShowOutOfStock(): boolean | null {
  return rememberedShowOutOfStock;
}

/** Test support: deterministic starting point across cases. */
export function resetStockPrefs(): void {
  rememberedShowOutOfStock = null;
}
