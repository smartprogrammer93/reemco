import type { PriceOffer } from "@/types/product";
import { safeHref } from "@/lib/safe-url";

/**
 * Merchant link resolution (REEA-25, revised by REEA-116).
 *
 * Every adapter — seeded catalog entries and the live retailer-search
 * fallbacks in collect/search-fallback.ts alike — emits the retailer's own
 * product URL (xcite.com, jarir.com, amazon.eg, talabat.com, berry hosts).
 * Render that URL directly: the "Go to store" link must land on the matching
 * retailer page so the shopper can compare title + price there. The old rule
 * (host allowlist of xcite only, everything else rewritten to a Bing SERP)
 * sent non-Xcite shoppers through an extra search hop instead of the store.
 *
 * The Bing search URL survives only as the last-resort fallback for offers
 * where no product URL was captured at all (missing/unparseable url field).
 */

const SEARCH_BASE = "https://www.bing.com/search?q=";

/** Working search URL for a merchant + product, used when no URL was captured. */
export function merchantSearchUrl(merchant: string, productTitle: string): string {
  return `${SEARCH_BASE}${encodeURIComponent(`${merchant} ${productTitle}`)}`;
}

/**
 * Resolve the href for an offer's buy link. Scraped URLs pass through
 * safeHref (REEA-13) — this is the single render path for offer links.
 * When the offer carries no usable product URL, fall back to a merchant +
 * title search URL so the link still reaches the right retailer/product.
 */
export function resolveOfferUrl(
  offer: Pick<PriceOffer, "merchant" | "url">,
  productTitle: string,
): string {
  const safe = safeHref(offer.url);
  if (safe) return safe;
  // No product URL captured: fall back to a working search URL.
  return merchantSearchUrl(offer.merchant, productTitle);
}
