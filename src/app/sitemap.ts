import type { MetadataRoute } from "next";
import { readEvents } from "@/lib/event-store";
import { PRODUCTS } from "@/lib/feed";
import { siteOrigin } from "@/lib/site-origin";
import {
  SITEMAP_QUERY_SEEDS,
  queriesWithResults,
  selectSitemapQueries,
} from "@/lib/sitemap-queries";
import { getTrendingChips } from "@/lib/trending-chips";
import { scrapeOffer } from "@/lib/collect/scraper";
import type { NormalizedProduct } from "@/types/product";

// REEA-1051 — sitemap handlers are cached/prerendered at build by default, so
// a build-time-only env would bake the origin into the artifact. The serving
// origin is runtime config (REEMCO_SITE_ORIGIN): render per request so the
// deployed box advertises itself and the DNS cutover flips it without a
// rebuild.
export const dynamic = "force-dynamic";

/** Upper bound on indexed query URLs: the curated seeds plus the recent
 *  top-query tail, enough long-tail coverage without an unbounded list. */
const MAX_QUERY_URLS = 20;

/** REEA-1189 — the last-24 h tally decides which trending queries to submit;
 *  a query whose latest search returned nothing is not an indexable page.
 *  A feed failure leaves `null`, which keeps the curated seeds and skips the
 *  filter rather than guessing. */
async function indexableQuerySet(nowMs: number): Promise<Set<string> | null> {
  try {
    return queriesWithResults(await readEvents(), nowMs);
  } catch {
    return null;
  }
}

/**
 * REEA-1168 AC-2 — the sitemap names the live surfaces:
 *
 *  - core pages (home/about/privacy/contact);
 *  - ≥10 query URLs: the homepage preset pills + category seeds merged with
 *    the last-24 h top queries by volume from the SAME anonymous funnel store
 *    the homepage chip row reads (lib/trending-chips.ts). Only the
 *    `/results?q=` shape is listed — `/search?q=` renders the identical live
 *    path, so listing both would offer one page twice;
 *  - stable product URLs from the catalog/feed identity list. These are URL
 *    identities only: the /product page still collects its offers live per
 *    request (REEA-114), so the sitemap never freezes a price.
 */

/** Bounded concurrency for the sitemap's live product check. */
const SITEMAP_PRODUCT_CHECK_CONCURRENCY = 4;
/** Per-listing ceiling: a crawler-facing check must not hold the response. */
const SITEMAP_PRODUCT_CHECK_TIMEOUT_MS = 2_500;
/** Re-check window: a listed/unlisted answer is reused for this long. */
const SITEMAP_PRODUCT_CHECK_TTL_MS = 10 * 60 * 1000;
const productCheckMemo = new Map<string, { at: number; hasOffer: boolean }>();

/**
 * REEA-1192 — does this catalog identity's product page render at least one
 * offer right now? Runs the same live listing re-check the PDP runs (catalog
 * seeds carry no collectedAt, so only a real fetch counts) with a short
 * per-listing ceiling. Fail-closed: a product whose check throws is omitted.
 */
async function productHasLiveOffer(product: NormalizedProduct): Promise<boolean> {
  const listings = product.offers ?? [];
  if (listings.length === 0) return false;
  const outcomes = await Promise.all(
    listings.map((offer) =>
      scrapeOffer(
        { ...offer, titleQuery: product.title },
        { timeoutMs: SITEMAP_PRODUCT_CHECK_TIMEOUT_MS },
      ).then(
        (outcome) => outcome.offers.length > 0,
        () => false,
      ),
    ),
  );
  return outcomes.some(Boolean);
}

async function sitemapProducts(products: readonly NormalizedProduct[]): Promise<NormalizedProduct[]> {
  const out: NormalizedProduct[] = [];
  const nowMs = Date.now();
  for (let i = 0; i < products.length; i += SITEMAP_PRODUCT_CHECK_CONCURRENCY) {
    const chunk = products.slice(i, i + SITEMAP_PRODUCT_CHECK_CONCURRENCY);
    const checks = await Promise.all(
      chunk.map(async (product) => {
        const memo = productCheckMemo.get(product.productId);
        if (memo && nowMs - memo.at < SITEMAP_PRODUCT_CHECK_TTL_MS) return { product, hasOffer: memo.hasOffer };
        const hasOffer = await productHasLiveOffer(product);
        productCheckMemo.set(product.productId, { at: nowMs, hasOffer });
        return { product, hasOffer };
      }),
    );
    for (const check of checks) if (check.hasOffer) out.push(check.product);
  }
  return out;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  // REEA-1051 — the origin follows REEMCO_SITE_ORIGIN (the host actually
  // serving), never a hard-coded rollback alias. See lib/site-origin.ts.
  const origin = siteOrigin();
  const corePages: MetadataRoute.Sitemap = [
    { url: origin, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${origin}/privacy`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${origin}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];

  // Top queries by volume: the same server-side tally the homepage chips use.
  // Any feed failure degrades to the curated seeds (getTrendingChips already
  // catches, but keep the sitemap render fail-open too).
  let trending: string[] = [];
  try {
    trending = (await getTrendingChips(SITEMAP_QUERY_SEEDS)).map((chip) => chip.query);
  } catch {
    trending = [];
  }
  // REEA-1189 — drop trending queries whose latest search returned zero
  // results (test queries and dead ends must not be submitted for indexing).
  const indexable = await indexableQuerySet(now.getTime());
  const queries = selectSitemapQueries(SITEMAP_QUERY_SEEDS, trending, indexable).slice(
    0,
    MAX_QUERY_URLS,
  );
  const queryPages: MetadataRoute.Sitemap = queries.map((query) => ({
    url: `${origin}/results?q=${encodeURIComponent(query)}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.9,
  }));

  // REEA-1192 — sitemap honesty: a /product/* URL is listed only when its
  // page actually has an offer to show. The catalog is an identity source,
  // not a price source (every /product page re-collects live), and a catalog
  // seed whose listing URLs have gone stale renders an empty table — a URL
  // advertised to crawlers and shoppers that answers "no offers" is a broken
  // promise. Check the same live listing set the PDP would re-check, bounded
  // and cached so crawlers do not re-pay it on every request.
  const listed = await sitemapProducts(PRODUCTS);
  const productPages: MetadataRoute.Sitemap = listed.map((product) => ({
    url: `${origin}/product/${encodeURIComponent(product.productId)}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...corePages, ...queryPages, ...productPages];
}
