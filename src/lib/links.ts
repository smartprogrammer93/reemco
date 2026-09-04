import type { PriceOffer } from "@/types/product";
import { safeHref } from "@/lib/safe-url";

/**
 * Merchant link resolution (REEA-25).
 *
 * Scraped merchant URLs go stale: product pages get delisted (404) or whole
 * merchant domains die. Probing every URL in the seed catalog (see REEA-25
 * evidence) showed jarir.com product URLs 404 and berry.com.kw /
 * techmart.talabat.com unreachable, while xcite.com resolves 200.
 *
 * Strategy: keep the scraped URL when the merchant host is verified healthy;
 * otherwise fall back to a web search for "<merchant> <product title>", which
 * always resolves and lands the user on the right merchant/product. Offers
 * whose URL fails safeHref validation get no buy link at all.
 */

/** Hosts verified to serve their scraped product URLs (HTTP 200). */
const HEALTHY_HOSTS = new Set(["www.xcite.com", "xcite.com"]);

const SEARCH_BASE = "https://www.bing.com/search?q=";

/** Working search URL for a merchant + product, used when the scraped URL is dead. */
export function merchantSearchUrl(merchant: string, productTitle: string): string {
  return `${SEARCH_BASE}${encodeURIComponent(`${merchant} ${productTitle}`)}`;
}

/**
 * Resolve the href for an offer's buy link, or null when the offer has no
 * usable destination (caller should hide the link). All rendered hrefs pass
 * through safeHref (REEA-13) — this is the single render path for offer links.
 */
export function resolveOfferUrl(
  offer: Pick<PriceOffer, "merchant" | "url">,
  productTitle: string,
): string | null {
  const safe = safeHref(offer.url);
  if (!safe) return null;
  const host = new URL(safe).hostname;
  if (HEALTHY_HOSTS.has(host)) return safe;
  // Unverified or known-dead scraped URL: fall back to a working search URL.
  return merchantSearchUrl(offer.merchant, productTitle);
}
