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
import { lastVerifiedObservation } from "@/lib/collect/last-observation";
import { scrapeOffer } from "@/lib/collect/scraper";
import { OFFER_STATUS_STALE_MS } from "@/lib/offer-status";
import { OVERALL_BUDGET_MS } from "@/lib/collect/types";
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
/** Re-check window: a listed/unlisted answer is reused for this long. */
const SITEMAP_PRODUCT_CHECK_TTL_MS = 10 * 60 * 1000;
const productCheckMemo = new Map<string, { at: number; hasOffer: boolean }>();

/** Race a check against a ceiling; a check that overruns is a "no".
 *  Exported for the focused REEA-1211 pin. */
export function withinBudget<T>(check: Promise<T>, fallback: T, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), budgetMs);
    void check.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * REEA-1192 / REEA-1211 — would this catalog identity's product page render
 * at least one offer right now?
 *
 * REEA-1211 — the check must use the SAME predicate and budget as the PDP's
 * first paint, or the sitemap and the page disagree. The old check granted
 * each listing a 2.5 s direct fetch plus the scraper's own search fallback
 * (two 8 s attempts) with no overall ceiling, while the PDP races every lane
 * against OVERALL_BUDGET_MS (10 s) — so the sitemap could advertise a URL
 * whose PDP run the budget cut off, painting an empty table.
 *
 * Two sources, the same two the page renders from (lib/collect/last-observation):
 *  1. a stored COMPLETED observation whose own stamp is inside the site's
 *     freshness window, which the page paints with its own collectedAt stamp
 *     — cheap, and no retailer fetch (rate-limit citizenship);
 *  2. a live re-check of the listing URLs, bounded by the PDP's per-lane
 *     ceiling and overall budget. Fail-closed: a check that throws or overruns
 *     is a "no".
 *
 * REEA-1168 AC-7 — the stored observation must also be FRESH: the PDP emits
 * no price claim from a row older than the window, so a URL whose only row is
 * stale must not be advertised as a structured-data product page.
 */
async function productWouldPaintOffer(product: NormalizedProduct): Promise<boolean> {
  const stored = await lastVerifiedObservation(product.productId);
  const nowMs = Date.now();
  if (
    stored?.some((offer) => {
      const observedAtMs = Date.parse(offer.collectedAt ?? "");
      return (
        Number.isFinite(observedAtMs) &&
        Math.max(0, nowMs - observedAtMs) <= OFFER_STATUS_STALE_MS
      );
    })
  ) {
    return true;
  }
  const listings = product.offers ?? [];
  if (listings.length === 0) return false;
  const outcomes = await withinBudget(
    Promise.all(
      listings.map((offer) =>
        scrapeOffer({ ...offer, titleQuery: product.title }).then(
          (outcome) => outcome.offers.length > 0,
          () => false,
        ),
      ),
    ),
    [] as boolean[],
    OVERALL_BUDGET_MS,
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
        const hasOffer = await productWouldPaintOffer(product);
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

  // REEA-1192 / REEA-1211 — sitemap honesty: a /product/* URL is listed only
  // when its page actually has an offer to show. The catalog is an identity
  // source, not a price source (every /product page re-collects live), and a
  // catalog seed whose listing URLs have gone stale renders an empty table — a
  // URL advertised to crawlers and shoppers that answers "no offers" is a
  // broken promise. The check asks the question the PDP itself answers
  // (lib/collect/last-observation): a stored verified observation OR a live
  // re-check inside the PDP's first-paint budget. Bounded and cached so
  // crawlers do not re-pay it on every request.
  const listed = await sitemapProducts(PRODUCTS);
  const productPages: MetadataRoute.Sitemap = listed.map((product) => ({
    url: `${origin}/product/${encodeURIComponent(product.productId)}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...corePages, ...queryPages, ...productPages];
}
