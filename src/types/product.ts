/**
 * Types for the normalized product data feed.
 * The Scraping/Data Engineer's feed must produce JSON matching these shapes;
 * see src/lib/feed.ts for the loader.
 */

export interface PriceOffer {
  merchant: string;
  price: number;
  currency: string; // ISO 4217, e.g. "USD"
  url: string;
  inStock: boolean;
  wasPrice?: number; // optional was-price for the F2 savings pill
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
}

export interface Coupon {
  code: string | null;
  description: string;
  discount: string; // human-readable, e.g. "10% off" or "$5 off"
  expiresAt: string | null; // ISO 8601
}

export interface ProductVariation {
  id: string;
  label: string; // e.g. "64GB / Black"
  priceDelta: number; // relative to the base offer
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
   * ISO 8601 timestamp of the scrape that produced this record (REEA-65 §4.1).
   * Mapped 1:1 from the feed's existing `scraped_at` metadata — no new data is
   * collected. Missing/undefined renders "Verification date unknown".
   */
  scrapedAt?: string;
}

export interface SearchResult {
  query: string;
  products: NormalizedProduct[];
}
