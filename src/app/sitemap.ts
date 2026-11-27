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
import {
  hasCollectionStamp,
  isFreshObservation,
  lastVerifiedObservation,
} from "@/lib/collect/last-observation";
import { startProductCollectionStaged } from "@/lib/collect/runner";
import { OVERALL_BUDGET_MS } from "@/lib/collect/types";
import { canonicalProductIdForSlug } from "@/lib/product-canonical";
import {
  SITEMAP_PRODUCT_CAP,
  sitemapProducts as liveCatalogProducts,
} from "@/lib/sitemap-products";
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
 *  - product URLs: one canonical key per SKU. REEA-1269 replaced the ten
 *    catalog seeds as the inventory source with the products the deployment
 *    actually collects (lib/sitemap-products.ts folds the durable live
 *    observation store at request time), and the catalog identities keep their
 *    REEA-1192/1211 offer check. Every product URL is an identity only: the
 *    /product page still collects its offers live per request (REEA-114), so
 *    the sitemap never freezes a price.
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
 * REEA-1211 — the check must be the PDP's OWN predicate, not a lookalike. The
 * old check granted each listing a 2.5 s direct fetch plus the scraper's own
 * search fallback (two 8 s attempts) with no overall ceiling, while the PDP
 * races every lane against OVERALL_BUDGET_MS (10 s) — so the sitemap could
 * advertise a URL whose PDP run the budget cut off, painting an empty table.
 * Measured on 4662f93: the sitemap still listed keychron-v3-max off a lucky
 * crawl-time 200 while the page's own run answered 503 and painted nothing.
 *
 * Three sources, and the invariant is "listed ⟹ the advertised URL renders
 * ≥1 offer row":
 *  1. the identity already carries stamped rows inside the freshness window
 *     (a shelf answer the page inherits as-is);
 *  2. a stored COMPLETED observation inside that same window, which the page
 *     seeds and paints with its own collectedAt stamp — cheap, and no retailer
 *     fetch (rate-limit citizenship);
 *  3. the PDP's own staged collection (startProductCollectionStaged), listed
 *     only when its first paint lands an offer. That run is the page's exact
 *     code path and it writes the store's completed observation on success, so
 *     the page that follows either seeds that observation (1 h retention) or
 *     attaches to the very job this check started with its offer already in
 *     hand. There is no window in which the sitemap promises more than the page
 *     can deliver.
 *
 * REEA-1168 AC-7 — a stored observation must also be FRESH: the PDP emits no
 * price claim from a row older than the window, so a URL whose only stored row
 * is stale must not be advertised as a structured-data product page.
 * Fail-closed: a check that throws or overruns its budget is a "no".
 */
async function productWouldPaintOffer(product: NormalizedProduct): Promise<boolean> {
  const nowMs = Date.now();
  const stamped = (product.offers ?? []).filter(hasCollectionStamp);
  if (stamped.some((offer) => isFreshObservation(offer, nowMs))) return true;
  const stored = await lastVerifiedObservation(product.productId, nowMs);
  if (stored) return true;
  return await withinBudget(
    startProductCollectionStaged(product).then(
      async (handle) => (await handle.firstStage).offers.length > 0,
      () => false,
    ),
    false,
    OVERALL_BUDGET_MS + 2_000,
  );
}

/** REEA-1192/1211 catalog-identity check (renamed in REEA-1269 so the live
 *  inventory fold can own the `sitemapProducts` name in lib/sitemap-products). */
async function catalogProductsWithOffers(
  products: readonly NormalizedProduct[],
): Promise<NormalizedProduct[]> {
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
  const catalogListed = await catalogProductsWithOffers(PRODUCTS);

  // REEA-1269 (Bet 1b) — indexable inventory. The catalog seeds above are ten
  // identities; the products this deployment actually collects live in the
  // durable last-seen store. lib/sitemap-products.ts folds those stored rounds
  // into canonical PDP keys (S-4: request-time, live-derived — no bundled
  // catalogue presented as live), and each entry carries the moment its round
  // was observed. Both sources are deduped onto ONE canonical key per SKU, so
  // a live merge key (`apple-iphone17-pro-256gb`) and its catalog identity
  // (`iphone-17-pro`) never both appear (S-2).
  const liveProducts = await liveCatalogProducts(queries, now.getTime());
  const productEntries: MetadataRoute.Sitemap = [];
  const listedCanonicalIds = new Set<string>();
  const addProduct = (canonicalId: string, lastModified: Date): void => {
    if (listedCanonicalIds.has(canonicalId)) return;
    if (productEntries.length >= SITEMAP_PRODUCT_CAP) return;
    listedCanonicalIds.add(canonicalId);
    productEntries.push({
      url: `${origin}/product/${encodeURIComponent(canonicalId)}`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    });
  };
  for (const product of liveProducts) {
    addProduct(product.canonicalId, new Date(product.observedAtMs));
  }
  for (const product of catalogListed) {
    addProduct(canonicalProductIdForSlug(product.productId), now);
  }

  return [...corePages, ...queryPages, ...productEntries];
}
