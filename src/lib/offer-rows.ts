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
