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
