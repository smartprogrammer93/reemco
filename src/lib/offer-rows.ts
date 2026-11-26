/**
 * REEA-1162 — the product page's offer table is a RETAILER comparison: one
 * row per distinct retailer offer, and its count line is the number of
 * DISTINCT retailers behind those rows.
 *
 * Live defect (REEA-1118 on d9f31b54): the collect run fans out one scrape per
 * listing the merged card carries (REEA-897/908 — correct for freshness), so a
 * retailer that listed several colourways of the same SKU at one price
 * produced several visually identical rows and the table's `{n}` read
 * `offers.length`: HD16 "All offers · 5 retailers" listed Eureka ×5 + Zayoom,
 * Tune 500 "4 retailers" listed Jarir + Danube Home ×3, DualSense "6
 * retailers" listed Wibi ×2, Astore ×2, Eureka ×2.
 *
 * Fold rule (pure, deterministic on the caller's order): rows that agree on
 * merchant + currency + price are the SAME offer seen twice — a colourway or
 * qualifier listing at the same price — so one row survives (the in-stock
 * occurrence wins over an out-of-stock twin). Rows at DIFFERENT prices stay:
 * they are genuinely different offers from that retailer, and the card→PDP
 * continuity contract (REEA-1140 D2) requires every card price to appear on
 * the PDP at the same price.
 *
 * The count is always the distinct-retailer count, never the row count: a
 * retailer with two real prices is still ONE retailer.
 */

import { normalizedListingUrlOf } from "@/lib/collect/types";

export interface RetailerRowKey {
  merchant: string;
  currency: string;
  price: number;
  inStock: boolean;
}

function merchantKey(merchant: string): string {
  return merchant.trim().toLowerCase();
}

/**
 * Collapse duplicate retailer rows. Same merchant + currency + price is one
 * offer; the in-stock occurrence survives (a row that cannot be bought must
 * not hide the one that can). Different prices keep their own rows.
 */
export function dedupeRetailerOfferRows<T extends RetailerRowKey>(
  offers: readonly T[],
): T[] {
  const kept = new Map<string, number>();
  const out: T[] = [];
  for (const offer of offers) {
    const merchant = merchantKey(offer.merchant);
    if (merchant === "") {
      out.push(offer);
      continue;
    }
    const key = `${merchant}|${offer.currency}|${offer.price}`;
    const at = kept.get(key);
    if (at === undefined) {
      kept.set(key, out.length);
      out.push(offer);
      continue;
    }
    // Same offer seen again — an in-stock occurrence replaces an out-of-stock
    // one in place so the rendered order stays stable.
    if (offer.inStock && !out[at].inStock) out[at] = offer;
  }
  return out;
}

/** Distinct named retailers behind a row set (empty merchant names excluded). */
export function distinctRetailerCount(offers: readonly { merchant: string }[]): number {
  const merchants = new Set<string>();
  for (const offer of offers) {
    const merchant = merchantKey(offer.merchant);
    if (merchant !== "") merchants.add(merchant);
  }
  return merchants.size;
}

/**
 * REEA-1192 — the product page starts from the shelf collection's offer set.
 *
 * The results card and the PDP are one click apart, so the PDP must inherit
 * the set the card rendered instead of showing only the lanes its own
 * re-check has reached at first paint. This merge keeps every inherited row
 * (query-time evidence: merchant, price, URL, collectedAt) in its original
 * order and lets a LIVE re-check replace the row it re-checked — same
 * listing (merchant + normalized URL) or the same offer (merchant +
 * currency + price). A live row that matches nothing is appended, so a
 * retailer discovered only by the PDP's own dispatch still appears.
 *
 * Rows without a collection stamp are NOT inherited: a catalog seed is an
 * identity hint, not live evidence, and must only render once a real fetch
 * confirmed it (the REEA-95 realtime policy).
 */
export interface InheritedOfferRow extends RetailerRowKey {
  url: string;
  collectedAt?: string;
}

/** Listing identity of a row: merchant + URL without query/trailing slash. */
function listingKeyOf(row: { merchant: string; url: string }): string {
  return `${merchantKey(row.merchant)}|${normalizedListingUrlOf(row.url)}`;
}

export function mergeInheritedOfferRows<T extends InheritedOfferRow>(
  inherited: readonly T[],
  live: readonly T[],
): T[] {
  const out = inherited.filter((o) => (o.collectedAt ?? "") !== "");
  const byListing = new Map<string, number>();
  const byOffer = new Map<string, number>();
  const offerKeyOf = (o: T) => `${merchantKey(o.merchant)}|${o.currency}|${o.price}`;
  out.forEach((o, i) => {
    byListing.set(listingKeyOf(o), i);
    const key = offerKeyOf(o);
    if (!byOffer.has(key)) byOffer.set(key, i);
  });
  for (const row of live) {
    const listing = listingKeyOf(row);
    const offer = offerKeyOf(row);
    const at = byListing.get(listing) ?? byOffer.get(offer);
    if (at !== undefined) {
      out[at] = row;
      byListing.set(listing, at);
      byOffer.set(offer, at);
      continue;
    }
    out.push(row);
    byListing.set(listing, out.length - 1);
    byOffer.set(offer, out.length - 1);
  }
  return out;
}
