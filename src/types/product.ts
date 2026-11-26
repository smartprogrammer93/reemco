/**
 * Types for the normalized product data feed.
 * The Scraping/Data Engineer's feed must produce JSON matching these shapes;
 * see src/lib/feed.ts for the loader.
 */

/**
 * REEA-963 R1 §4 — the per-offer sanity annotation computed at query time
 * over the render cohort (all offers the adapters returned for one query
 * execution). `status: "ok"` offers carry no reason; flagged offers stay
 * visible but render a "price needs verification" affordance and are
 * excluded from every rollup and best-price claim (spec FR-1.3/FR-1.4).
 */
export type SanityReason =
  | "outlier_high"
  | "outlier_low"
  | "currency_mis_map"
  | "unclassified_variant"
  | "price_unavailable";

export interface OfferSanity {
  status: "ok" | "flagged";
  /** Present when status is "flagged". */
  reason?: SanityReason;
  /** price / cohort-median ratio in KWD space; absent when no median was computed. */
  ratioToMedian?: number;
}

/**
 * REEA-1177 (Bet 6a) — the one reconciling price statement for an offer:
 * listed − appliedDiscount = effective. `kind` names what the discount is:
 * a was-price markdown the retailer itself carries, or a coupon. `effective`
 * is null when the discount is conditional (percent/cap/minimum) and the
 * applied value is unknown — the UI must then not subtract a face value.
 * Figures are in the offer's own native currency; `effectivePrice` on the
 * offer carries the KWD-space ordering figure.
 */
export interface PriceComposition {
  listed: number;
  appliedDiscount: number | null;
  effective: number | null;
  kind: "was_price" | "coupon";
}

export interface PriceOffer {
  merchant: string;
  price: number;
  currency: string; // ISO 4217, e.g. "USD"
  /**
   * REEA-1177 AC 6a-1 — the KWD-space amount the shopper pays at checkout.
   * Ranking, the "from" price and the card headline use this one figure.
   */
  effectivePrice?: number | null;
  /** REEA-1177 AC 6a-1 — listed − appliedDiscount = effective, with kind. */
  priceComposition?: PriceComposition;
  /**
   * REEA-1142 AC3 — the market the listing's own storefront serves, derived
   * from its currency by the adapter tag (KW→KWD, SA→SAR, EG→EGP). Every
   * live offer carries this tag so the renderer can mark a cross-market row
   * explicitly instead of silently treating it as local stock. Absent on
   * feeds that predate the tag; the renderer then derives it from currency.
   */
  market?: string;
  url: string;
  inStock: boolean;
  wasPrice?: number; // optional was-price for the F2 savings pill
  /**
   * REEA-1070 AC7 — the named savings baseline for this offer's "Save"
   * figure: struck − current (±0.01) plus the retailer/listed price it is
   * measured against. Absent when the listing carries no compare-at price
   * that exceeds the current price; the UI then renders no savings claim.
   */
  savings?: import("@/lib/savings").OfferSavings;
  /**
   * REEA-963 — the query-time sanity verdict for THIS offer (the cohort pass
   * in lib/collect/price-sanity.ts). Absent on surfaces that never ran the
   * pass (catalog feed seeds, suggestion pills).
   */
  sanity?: OfferSanity;
  /**
   * REEA-167 §2 condition grade of this listing ("renewed-grade-b", …),
   * present only when it differs from `new`. Grades keep their own rows with
   * visible badges and their own prices; never averaged into the new set.
   */
  grade?: string;
  /**
   * REEA-281 AC-1 — the retailer's own product image for THIS listing, when
   * its contract carries one. Absent when the feed carries no image; result
   * rows then render text-only (the graceful fallback), never a placeholder.
   */
  image?: string;
  /**
   * REEA-486 AC-6 — the listing's own qualifier beyond the merged card
   * title ("Japanese Version", "eSIM"), so folding several spellings of one
   * model into one card never loses what distinguishes a row inside it.
   * Absent when the listing says nothing beyond the card title.
   */
  label?: string;
  /**
   * REEA-486 AC-2 — ISO stamp of the moment THIS retailer's answer landed in
   * the live run, so each row's freshness is traceable to its own hop, not
   * just to the card's completion stamp. Absent on catalog-fallback rows.
   */
  collectedAt?: string;
  /**
   * REEA-1070 AC10 — the same collection moment as epoch milliseconds, so
   * EN/AR clients humanise it ("just now / 4 min ago" / `حُدِّث قبل دقيقتين`)
   * against their own clock instead of receiving a preformatted "0s ago".
   */
  collectedAtEpochMs?: number;
  /**
   * REEA-510 — true when the row was replayed from the retailer's ≤24 h
   * last-seen snapshot after its LIVE pass stayed silent for the query.
   * Flagged rows sort below every live row and render their snapshot
   * collection clock ("collected HH:MM"), so a filled column never reads as
   * a fresh answer. The live path stays primary: a fresh live answer replaces
   * the snapshot automatically on the next query.
   */
  fromSnapshot?: boolean;
}

export interface Coupon {
  code: string | null;
  description: string;
  discount: string; // human-readable, e.g. "10% off" or "$5 off"
  expiresAt: string | null; // ISO 8601
  /**
   * REEA-760 — the issuing retailer, stamped onto the record by the hop that
   * delivered it (live-at-query-time attribution). Records without one fall
   * back to the card's cheapest ANSWERING merchant at render time — never a
   * guess beyond what the served rows carry.
   */
  merchant?: string;
}

export interface ProductVariation {
  id: string;
  label: string; // e.g. "64GB / Black"
  priceDelta: number; // relative to the base offer
  /**
   * REEA-963 FR-3.3 — true when every offer classified into this variant
   * family was flagged by the sanity pass: the chip renders the "price needs
   * verification" warning state instead of a price (no price can be claimed
   * from flagged members only).
   */
  needsVerification?: boolean;
}

export interface ProductAlternative {
  productId: string;
  title: string;
  fromPrice: number;
}

/** A single normalized product record from the feed. */
export interface NormalizedProduct {
  productId: string;
  title: string;
  brand: string;
  image?: string;
  offers: PriceOffer[];
  coupons: Coupon[];
  variations: ProductVariation[];
  alternatives: ProductAlternative[];
  /**
   * REEA-592 (REEA-575 spec R2) — the capped secondary "Pairs with" row:
   * complementary accessory items of this card's product, cheapest-first,
   * max 3 entries. Optional: an empty or absent list renders NOTHING (R4),
   * so feed seeds and older snapshot records stay valid without it.
   */
  pairsWith?: ProductAlternative[];
  /**
   * ISO 8601 timestamp of the scrape that produced this record (REEA-65 §4.1).
   * Mapped 1:1 from the feed's existing `scraped_at` metadata — no new data is
   * collected. Missing/undefined renders "Verification date unknown".
   */
  scrapedAt?: string;
  /**
   * REEA-1070 AC10 — the same scrape moment as epoch milliseconds so the
   * EN/AR UI can humanise the collection timestamp itself ("just now /
   * 4 min ago" / `حُدِّث قبل دقيقتين`), never a preformatted "0s ago".
   */
  scrapedAtEpochMs?: number;
  /**
   * REEA-540 Bet A — the results-list confidence line: min/max of the
   * merchant-day observations the last-seen store kept for this query
   * (REEA-510 rows) inside the rolling 14-day window. Computed SERVER-side
   * when the snapshot is built (src/lib/seen-range.ts); absent when the
   * window holds fewer than 3 distinct observation days — the card then
   * renders nothing. The detail view keeps its hierarchy and never shows it.
   */
  seenRange?: SeenRange;
}

/** REEA-540 Bet A — one endpoint: the native figure and its scraped currency. */
export interface SeenRange {
  min: { price: number; currency: string };
  max: { price: number; currency: string };
  /**
   * REEA-1167 — true when exactly one scoped observation survived the
   * product/market fold. The card then renders "First seen: <price>" (a
   * single observation is honest) instead of a 14-day range.
   */
  firstSeen?: boolean;
}

export interface SearchResult {
  query: string;
  products: NormalizedProduct[];
}
