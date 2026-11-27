/**
 * REEA-1212 — the ONE visible-offer projection behind a results shelf card.
 *
 * Why this module exists: the shelf card and the Product/Offer JSON-LD used
 * to derive their offer sets through different chains. The card applied the
 * market selection, the real-coupon composition, the retailer-row fold and
 * the 3-row anatomy; the structured data read the raw `product.offers` with
 * its own freshness/snapshot filter. On `/results?q=iphone 17 pro` that made
 * the JSON-LD omit the card's visible best offer (Wibi, coupon-effective
 * KD 314.90) and advertise KD 319.90 instead — a rich result that
 * contradicted the page it annotates.
 *
 * The projection here is pure arithmetic over the served snapshot and is
 * shared by `ProductResultCard` and `lib/structured-data.ts`, so a price
 * claim in the page head can never describe a different offer set from the
 * rows the shopper sees. No fetch, no bundled catalogue, no client work.
 */
import type { CountryCode } from "@/lib/country";
import { dedupVariantKey, gradeBadgeLabel } from "@/lib/collect/canonical-product";
import { formatKWD } from "@/lib/format";
import {
  cheapestCrossMarketOffer,
  headlineOfferFor,
  scopeProductsByMarket,
  sortOffersByMarket,
} from "@/lib/market";
import {
  effectiveKwdOfOffer,
  realCouponsFor,
  withCouponComposition,
} from "@/lib/price-composition";
import type { Coupon, NormalizedProduct, PriceOffer } from "@/types/product";

/**
 * REEA-1096 D6 — the accepted shelf card anatomy caps the visible offer rows
 * at three (the pack's card height target assumes a bounded row set; the PM
 * brief for that ticket fixes the cap at 3). The rest stay reachable through
 * the product page's full offers table via the "view all N offers" link.
 */
export const SHELF_VISIBLE_OFFER_ROWS = 3;

/**
 * REEA-787 — variant-aware retailer-row fold, applied right AFTER sortOffers
 * so it inherits the single REEA-604 ordering key and the stable live-first
 * order. One row survives per (merchant(lower) | folded variant tier | grade
 * badge | effective figure).
 */
export function foldRetailerRows(
  offers: PriceOffer[],
  coupon: { discount: string } | null,
): PriceOffer[] {
  void coupon; // the served composition already folds the card's real coupon
  const seen = new Set<string>();
  const rows: PriceOffer[] = [];
  for (const o of offers) {
    // REEA-1177 AC 6a-4 — the fold key is the SAME effectivePrice the card
    // prints and ranks on, never a face-value subtraction.
    const effective = effectiveKwdOfOffer(o);
    const key = [
      o.merchant.toLowerCase(),
      dedupVariantKey(o.label ?? ""),
      gradeBadgeLabel(o.grade ?? "") ?? "",
      formatKWD(effective),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(o);
  }
  return rows;
}

export interface VisibleShelfOffers {
  /** The rows the card paints, in paint order, capped at the shelf anatomy. */
  rows: PriceOffer[];
  /**
   * REEA-1217 — the card's paint rows with the headline offer pinned in when
   * the live-first ladder would push it beyond the cap. A last-seen snapshot
   * best price sorts after live rows (REEA-510), so `rows` alone could omit
   * the very merchant the card headlines (live `apple-iphone17-pro-256gb`:
   * Wibi KD 314.90 led the headline while Xcite / Eureka held the visible
   * rows). The card paints this set; the JSON-LD keeps `rows` + `best`
   * because structured data may describe the row behind "view all".
   */
  cardRows: PriceOffer[];
  /** The full folded/sorted set behind the "view all N offers" disclosure. */
  all: PriceOffer[];
  /** Cheapest in-stock, unflagged offer of the selected market (headline). */
  localBest: PriceOffer | null;
  /** Cheapest in-stock, unflagged cross-market offer (disclosed fallback). */
  crossBest: PriceOffer | null;
  /**
   * The offer the card headline and composition line speak for: the local
   * headline, else the disclosed cross-market fallback, else the first
   * painted row. This is the ONE "best visible price" definition.
   */
  best: PriceOffer | null;
  /** Real (non-derived) coupons applied to the composed rows. */
  realCoupons: Coupon[];
}

/**
 * Project the exact offer set a results shelf card renders for this product
 * under the given market selection: the same market scoping, coupon
 * composition, live-first/effective ordering, retailer fold and row cap the
 * card uses. The card and the JSON-LD both call this, so neither can drift.
 */
export function visibleShelfOffers(
  product: NormalizedProduct,
  scope: CountryCode | null,
): VisibleShelfOffers {
  const scoped = scopeProductsByMarket([product], scope)[0];
  const scopedOffers = scoped?.offers ?? [];
  // REEA-1177 AC 6a-3 — derived was-price coupon entries are not coupons;
  // only real coupons are applied to the composition and rendered as badges.
  const realCoupons = realCouponsFor(product.coupons, scopedOffers);
  const composedOffers = withCouponComposition(scopedOffers, realCoupons);
  const all = foldRetailerRows(sortOffersByMarket(composedOffers, null, scope), null);
  const localBest = headlineOfferFor(all, scope);
  const crossBest = cheapestCrossMarketOffer(all, scope);
  const best = localBest ?? crossBest ?? all[0] ?? null;
  const rows = all.slice(0, SHELF_VISIBLE_OFFER_ROWS);
  // REEA-1217 — the card's own list must carry the merchant it headlines.
  // REEA-1238 AC 7B-2b — a comparison card must also VISIBLY carry both
  // retailers it claims to compare: with six offers from one retailer the
  // three-row cap showed three rows of that retailer and the other merchant
  // only behind "View all", so the card read as a single-retailer card even
  // though its own basis line said "2 retailers". The row selection now takes
  // one row per distinct retailer first (headline included), then fills the
  // remaining slots in the served cheapest-first order.
  const cardRows = (() => {
    const cap = SHELF_VISIBLE_OFFER_ROWS;
    const picked: PriceOffer[] = [];
    const merchants = new Set<string>();
    const take = (o: PriceOffer): void => {
      if (picked.length >= cap || picked.includes(o)) return;
      picked.push(o);
      merchants.add(o.merchant.trim().toLowerCase());
    };
    if (best != null) take(best);
    for (const o of all) {
      if (picked.length >= cap) break;
      if (merchants.has(o.merchant.trim().toLowerCase())) continue;
      take(o);
    }
    for (const o of all) {
      if (picked.length >= cap) break;
      take(o);
    }
    return picked;
  })();
  return {
    rows,
    cardRows,
    all,
    localBest,
    crossBest,
    best,
    realCoupons,
  };
}
