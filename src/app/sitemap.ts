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

  // Stable product identities from the feed facade. The catalog list is an
  // identity source, not a price source: every /product page re-collects live.
  const productPages: MetadataRoute.Sitemap = PRODUCTS.map((product) => ({
    url: `${origin}/product/${encodeURIComponent(product.productId)}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...corePages, ...queryPages, ...productPages];
}
