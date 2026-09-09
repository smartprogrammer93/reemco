/**
 * REEA-114 — live query-time result collection for /results.
 *
 * Data policy (REEA-95 realtime-policy): every results view is collected LIVE
 * from the retailers at query time. The page never renders a seeded/snapshot
 * array — on each request the query fans out to the retailers' own documented
 * search endpoints (the same contracts search-fallback.ts uses for per-product
 * fallbacks) and the returned hits ARE the results. scrapedAt is the real
 * completion timestamp of the run, so freshness chips show true ages.
 *
 * Budgets mirror the collection runner: each retailer gets its own timeout
 * (independent, parallel); `Promise.allSettled` renders whatever arrived. A
 * retailer that fails never blocks the others; failures are dropped silently
 * in production but surfaced in tests via the returned diagnostics.
 */
import {
  APP_ID_ALLOW,
  SEARCH_KEY_ALLOW,
  brandAwareCoverage,
  extractJarirIndexKey,
  extractJsonLdProducts,
  fetchThroughChallenge,
  jarirIndexLang,
  normalizeShopifyProducts,
  scanNextStoreCards,
  scanWooCards,
  titleMatchScore,
} from "@/lib/collect/search-fallback";
import { defaultQueryCache, queryCacheKey, type QueryCache, type QueryCacheHit } from "@/lib/query-cache";
import type { FetchImpl } from "@/lib/collect/scraper";
import type { CountryCode } from "@/lib/country";
import { sanitizeExternalUrl } from "@/lib/safe-url";
import { toKwdNumeric } from "@/lib/format";
import { canonicalFields, compatibleFields, type CanonicalFields } from "@/lib/collect/canonical-product";
import {
  arabicBrandIntent,
  brandIsNamed,
  isAccessoryTitle,
  isModelExtended,
  matchesQueryToken,
  queryMatchTokens,
  relevanceTier,
  resolveBrand,
  titleMatchesBrand,
} from "@/lib/relevance";
import type { NormalizedProduct, PriceOffer, ProductAlternative, ProductVariation } from "@/types/product";

/**
 * Per-attempt fetch ceiling for the search fan-out (parallel per retailer).
 * REEA-156: raised from 3.5 s to match PER_RETAILER_TIMEOUT_MS in types.ts —
 * the live fan-out had been held 0.5 s stricter than the product-page
 * collection runner's own per-retailer budget with no reason. Measured on the
 * deployed edge, that half-second decided whole retailers: every page already
 * waits ~4 s for the slowest collector, so a blink answer arriving at ~3.8 s
 * — or amazon.eg's second apology-page attempt finishing inside the doubled
 * window — was being discarded after already arriving.
 */
export const LIVE_SEARCH_TIMEOUT_MS = 4_000;
/**
 * Ceiling for the whole query-time chain: bounded per-attempt windows above,
 * one round of parallel collectors plus one bounded enrichment retry for
 * silent retailers (REEA-149). Each round's slowest hop is the two-step
 * chain at TIMEOUT×2; two rounds stay inside the results page maxDuration.
 * REEA-224 F4: the ceiling is enforced, not just documented — collectLiveResults
 * wraps the chain in AbortSignal.timeout(LIVE_SEARCH_BUDGET_MS) and threads the
 * signal through every fetchChecked hop (joinSignals lets the sooner of budget
 * / per-attempt window decide).
 */
export const LIVE_SEARCH_BUDGET_MS = 16_000;
/** Cap of distinct product groups served per query. */
export const LIVE_SEARCH_MAX_PRODUCTS = 20;
/**
 * REEA-156 — per-source page size for the query-time fan-out. Tail
 * model-number queries ("lg gram", "dyson airwrap") are the thin lists: each
 * retailer's own index answers them with only a handful of relevant variants,
 * and the old 12-hit window itself became binding — measured live, xcite
 * answered "airpods pro 2" with a full 12 fetched/12 relevant and "lg gram"
 * with 12 fetched/17 relevant at a wider window, i.e. the page cut the tail
 * of relevant hits, not relevance. One wider page per retailer keeps head
 * queries unchanged (selection is still capped at MAX_PRODUCTS groups) while
 * thin lists arrive with enough variants to stand on their own. Same single
 * request per retailer as before; nothing extra is fetched.
 */
export const LIVE_SEARCH_HITS_PER_PAGE = 24;

/**
 * REEA-149 — polite pause between the two bounded amazon.eg attempts. A retry
 * issued in the same millisecond as an HTTP 503 tends to hit the same rate
 * limiter; 200 ms is enough for a clean answer on the live host (measured)
 * while keeping attempt+backoff+attempt inside the TIMEOUT×2 hop window.
 */
export const AMAZON_RETRY_BACKOFF_MS = 200;

export interface SearchHit {
  title: string;
  merchant: string;
  /**
   * REEA-189 — the retailer's own brand field for this listing, kept verbatim
   * from the payload (casing/stop-value handling lives in resolveBrand).
   * Absent when the retailer contract carries no brand attribute.
   */
  brand?: string;
  price: number;
  currency: string;
  url: string;
  inStock: boolean;
  wasPrice?: number;
  /**
   * REEA-281 AC-1 — the retailer's product image for this listing, picked up
   * by the same symmetric candidate chain as the brand field. Absent when the
   * retailer contract carries no image; the row then renders without one.
   */
  image?: string;
  /**
   * REEA-170 — country tag stamped by the retailer adapter that produced the
   * hit (each adapter is scoped to one storefront's country). The results-page
   * country filter matches on this tag; offers stay fetched live.
   */
  country: CountryCode;
}

/**
 * Minimum title/query relevance for a hit to be served as a result, compared
 * with tokenCoverage (share of query tokens found in the hit title) so long
 * descriptive retailer titles are not punished for their length (REEA-137).
 * titleMatchScore stays for grouping/ranking, which wants a symmetric fit.
 */
const MIN_SCORE = 0.25;

interface RetailerCollector {
  merchant: string;
  /** REEA-170 — storefront country this adapter answers from. */
  country: CountryCode;
  collect: (query: string, fetchImpl: FetchImpl) => Promise<SearchHit[]>;
}

/**
 * REEA-141 — per-instance TTL cache for the two-step collectors' discovery hop
 * (eureka's Algolia keys, jarir's Constructor index key). Discovery is
 * credential lookup, not offer data: the offer query itself still runs live on
 * every call, so the data policy is untouched. The hop is what makes these two
 * collectors a sequential chain — homepage HTML first, search API second — and
 * on slow edges the whole chain overruns the collector window, silently losing
 * the retailer from the page breadth. With the hop cached, a warm instance
 * answers these collectors in a single round-trip, matching the one-step
 * retailers. Expired entries just re-run the chain; nothing is bundled.
 */
const DISCOVERY_TTL_MS = 5 * 60_000;
const discoveryCache = new Map<string, { values: string[]; expiresAt: number }>();

/**
 * REEA-152 allowlists (REEA-224 F3: shared single source now lives in
 * search-fallback.ts so both discovery-hop paths — this cached collector
 * chain and the per-product fallbacks — validate with the exact same
 * alphabets). Values are checked before entering the cache, so cache reads
 * inherit the guarantee.
 */

function readDiscovery(name: string): string[] | null {
  const hit = discoveryCache.get(name);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    discoveryCache.delete(name);
    return null;
  }
  return hit.values;
}

function writeDiscovery(name: string, values: string[]): void {
  discoveryCache.set(name, { values, expiresAt: Date.now() + DISCOVERY_TTL_MS });
}

/** Test support: make discovery counts deterministic across test cases. */
export function resetDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * REEA-224 F4 — combine the overall budget signal with a per-attempt window:
 * the joined signal aborts when EITHER source does — AbortSignal.any where
 * available, mirrored listeners otherwise — so budget threading works on any
 * runtime while each hop keeps its own tighter attempt ceiling.
 */
function joinSignals(budget: AbortSignal, attempt: AbortSignal | undefined): AbortSignal {
  if (!attempt) return budget;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([budget, attempt]);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  if (budget.aborted || attempt.aborted) abort();
  else {
    budget.addEventListener("abort", abort, { once: true });
    attempt.addEventListener("abort", abort, { once: true });
  }
  return ctl.signal;
}

async function fetchChecked(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const res = await fetchImpl(url, { ...init, cache: "no-store", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/* ---- Per-retailer hit extraction (documented contracts only). ---- */

/**
 * REEA-189 — symmetric brand pickup: every JSON adapter reads its brand with
 * the same candidate chain (payloads name it `brand`, `brand_name`, Shopify's
 * `vendor`, `manufacturer`). The value is kept verbatim; Rule 1 hygiene
 * (stop-values, curated casing) runs later in resolveBrand so each adapter
 * stays a thin contract mapping.
 */
function pickBrand(hit: Record<string, unknown>): string | undefined {
  for (const key of ["brand", "Brand", "brand_name", "brandName", "vendor", "manufacturer"]) {
    const v = hit[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * REEA-281 AC-1 — symmetric image pickup, the same candidate-chain shape as
 * pickBrand: every JSON adapter reads its listing photo through this shared
 * helper (contract key names differ per retailer; the chain covers them all).
 * Shopify-style payloads carry the photo as an object (`url`/`src` field);
 * plain-string variants pass through. Validated through the same render-time
 * allowlist as every other scraped URL (REEA-13). Absent keys stay absent —
 * the card renders its text-only fallback rather than invent a placeholder.
 */
function pickImage(hit: object): string | undefined {
  const rec = hit as Record<string, unknown>;
  for (const key of ["image", "imageUrl", "image_url", "image_path", "imagepath", "featured_image", "thumbnail", "picture"]) {
    const v = rec[key];
    const raw =
      typeof v === "string"
        ? v
        : v && typeof v === "object"
          ? ((v as { url?: unknown; src?: unknown }).url ??
            (v as { url?: unknown; src?: unknown }).src)
          : undefined;
    if (typeof raw !== "string") continue;
    const src = sanitizeExternalUrl(raw.trim());
    if (src) return src;
  }
  return undefined;
}

export function xciteHits(payload: unknown, query: string): SearchHit[] {
  const hits =
    (payload as { results?: { hits?: Record<string, unknown>[] }[] })?.results?.[0]?.hits ?? [];
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const title = typeof hit.name === "string" ? hit.name : "";
    const price = typeof hit.price === "number" ? hit.price : NaN;
    const slug = typeof hit.slug === "string" ? hit.slug : "";
    if (!title || !Number.isFinite(price) || price <= 0 || !slug) continue;
    if (brandAwareCoverage(title, query) < MIN_SCORE) continue;
    const unmodified = typeof hit.unmodifiedPrice === "number" ? hit.unmodifiedPrice : undefined;
    const brand = pickBrand(hit);
    const img = pickImage(hit);
    out.push({
      title,
      merchant: "Xcite",
      country: "KW",
      ...(brand ? { brand } : {}),
      price,
      currency: typeof hit.currency === "string" ? hit.currency : "KWD",
      url: `https://www.xcite.com/${slug}/p`,
      inStock: hit.inStock === true || hit.status_key === "InStock",
      ...(unmodified != null && unmodified > price ? { wasPrice: unmodified } : {}),
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

export function blinkHits(payload: unknown, query: string): SearchHit[] {
  // The live hop answers the suggest.json envelope; older products.json
  // fixtures stay readable — normalizeShopifyProducts folds both shapes.
  const products = normalizeShopifyProducts(payload);
  const out: SearchHit[] = [];
  for (const p of products) {
    const variant = p.variants?.[0];
    const price = variant?.price != null ? Number(variant.price) : NaN;
    if (!p.title || !p.handle || !Number.isFinite(price) || price <= 0) continue;
    if (brandAwareCoverage(p.title, query) < MIN_SCORE) continue;
    const brand = pickBrand(p as unknown as Record<string, unknown>);
    const img = pickImage(p);
    out.push({
      title: p.title,
      merchant: "Blink",
      country: "KW",
      ...(brand ? { brand } : {}),
      price,
      currency: "KWD",
      url: `https://blink.com.kw/products/${p.handle}`,
      inStock: variant?.available ?? true,
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

export function eurekaHits(payload: unknown, query: string): SearchHit[] {
  const hits =
    (payload as { hits?: { itmn?: string; objectID?: string; lprc?: number; clprc?: number; avaqt?: number; brand?: string }[] })
      ?.hits ?? [];
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (!hit.itmn || !hit.objectID || typeof hit.clprc !== "number" || hit.clprc <= 0) continue;
    if (brandAwareCoverage(hit.itmn, query) < MIN_SCORE) continue;
    const brand = pickBrand(hit as unknown as Record<string, unknown>);
    const img = pickImage(hit as unknown as Record<string, unknown>);
    out.push({
      title: hit.itmn,
      merchant: "Eureka",
      country: "KW",
      ...(brand ? { brand } : {}),
      price: hit.clprc,
      currency: "KWD",
      // The store's canonical product route is /products/details/<id>; the
      // /en/<Title>/<id> variant hard-404s on the live host (REEA-136).
      url: `https://www.eureka.com.kw/products/details/${hit.objectID}`,
      inStock: typeof hit.avaqt === "number" ? hit.avaqt > 0 : true,
      ...(typeof hit.lprc === "number" && hit.lprc > hit.clprc ? { wasPrice: hit.lprc } : {}),
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

export function sultanCenterHits(payload: unknown, query: string): SearchHit[] {
  const list =
    (payload as { products?: { product_list?: { name?: string; slug?: string; price?: string; spclprice?: string; is_in_stock?: string; currencysymbol?: string; brand?: string }[] } })
      ?.products?.product_list ?? [];
  const out: SearchHit[] = [];
  for (const item of list) {
    const title = item?.name ?? "";
    const slug = item?.slug ?? "";
    if (!title || !slug) continue;
    // Price arrives as a numeric string ("1.1800"); spclprice, when set, is
    // the running promo price with the regular price carried in `price`.
    const regular = Number(item.price);
    const special = item.spclprice ? Number(item.spclprice) : NaN;
    const promo = Number.isFinite(special) && special > 0 && special < regular;
    const price = promo ? special : regular;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (brandAwareCoverage(title, query) < MIN_SCORE) continue;
    const brand = pickBrand(item as unknown as Record<string, unknown>);
    const img = pickImage(item as unknown as Record<string, unknown>);
    out.push({
      title,
      merchant: "Sultan Center",
      country: "KW",
      ...(brand ? { brand } : {}),
      price,
      // Grocery prices on this storefront are quoted in KD (= KWD).
      currency: item.currencysymbol && item.currencysymbol !== "KD" ? item.currencysymbol : "KWD",
      url: `https://www.sultan-center.com/product/${slug}`,
      // Listed-with-price implies purchasable (same rule as extractInStock);
      // is_in_stock "0" is the explicit negative case.
      inStock: item.is_in_stock === undefined ? true : Number(item.is_in_stock) > 0,
      ...(promo ? { wasPrice: regular } : {}),
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

export function jarirHits(payload: unknown, query: string): SearchHit[] {
  const results =
    (payload as { response?: { results?: { data?: { url?: string; price?: number | string; metadata?: { name?: string; price?: string; brand?: string } } }[] } })
      ?.response?.results ?? [];
  const out: SearchHit[] = [];
  for (const item of results) {
    const data = item?.data;
    const title = data?.metadata?.name ?? "";
    // Price rides either on data.price or Constructor metadata.price — as a
    // number or a numeric string depending on the index generation.
    const rawPrice = data?.price ?? data?.metadata?.price;
    const price = Number(rawPrice);
    const slug = data?.url ?? "";
    if (!Number.isFinite(price) || price <= 0 || !title || !slug) continue;
    if (brandAwareCoverage(title, query) < MIN_SCORE) continue;
    // REEA-195 — brand pickup through the same candidate chain as every other
    // JSON adapter: jarir's Constructor metadata carries `brand`, and the
    // Arabic index ships it populated ("Apple") — the Arabic path must not
    // lose the brand line just because the field sits in metadata.
    const brand = pickBrand((data?.metadata ?? {}) as Record<string, unknown>);
    const img = pickImage((data?.metadata ?? {}) as Record<string, unknown>);
    out.push({
      title,
      merchant: "Jarir",
      country: "SA",
      ...(brand ? { brand } : {}),
      price,
      // Constructor hits on jarir.com carry SAR; rendered as scraped (REEA-60 §7.1).
      currency: "SAR",
      url: `https://www.jarir.com/${slug}`,
      // Listed-with-price implies purchasable (same rule as extractInStock).
      inStock: true,
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

/** amazon.eg `/s?k=` cards → hits (also exported for the single-best parser). */
export function amazonEgHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  const wanted = queryMatchTokens(query);
  for (const seg of html.split('data-component-type="s-search-result"').slice(1)) {
    const asin = seg.match(/\/dp\/([A-Z0-9-]{6,12})/)?.[1];
    const priceRaw = (seg.match(/class="a-offscreen">[^<]*?([\d٠-٩][٠-٩\d.,٫٬]*)/)?.[1] ?? "")
      .replace(/[٫]/g, ".")
      .replace(/[٬]/g, ",")
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    if (!asin || !priceRaw) continue;
    const price = Number.parseFloat(priceRaw.replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    const h2 = seg.match(/<h2[^>]*>([\s\S]{0,400}?)<\/h2>/);
    const title = (seg.match(/<h2[^>]*aria-label="([^"]+)"/)?.[1] ?? h2?.[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) continue;
    if (wanted.length > 0) {
      const lower = title.toLowerCase();
      let matched = 0;
      for (const t of wanted) if (matchesQueryToken(lower, t)) matched++;
      if (matched / wanted.length < MIN_SCORE) continue;
    }
    out.push({
      title,
      merchant: "Amazon.eg",
      country: "EG",
      price,
      currency: "EGP",
      url: `https://www.amazon.eg/dp/${asin}`,
      inStock: !/غير متوفر|out of stock/i.test(seg),
    });
  }
  return out;
}

/**
 * Quadra Stores (quadrastores.com) ships the same Shopify suggest.json
 * contract as blink, with one difference worth mapping: its variant option1
 * carries the manufacturer ("ASUS") while the product-level vendor holds the
 * store's own name — option1 wins the brand line, vendor is only the backup.
 * compare_at_price, when above the selling price, is the running discount's
 * old price.
 */
export function quadraHits(payload: unknown, query: string): SearchHit[] {
  const products = normalizeShopifyProducts(payload);
  const out: SearchHit[] = [];
  for (const p of products) {
    const variant = p.variants?.[0];
    const price = variant?.price != null ? Number(variant.price) : NaN;
    if (!p.title || !p.handle || !Number.isFinite(price) || price <= 0) continue;
    if (brandAwareCoverage(p.title, query) < MIN_SCORE) continue;
    const brand = variant?.option1?.trim() || pickBrand(p as unknown as Record<string, unknown>);
    const img = pickImage(p);
    const compare = variant?.compare_at_price != null ? Number(variant.compare_at_price) : NaN;
    out.push({
      title: p.title,
      merchant: "Quadra Stores",
      country: "KW",
      ...(brand ? { brand } : {}),
      price,
      currency: "KWD",
      url: `https://quadrastores.com/products/${p.handle}`,
      inStock: variant?.available ?? true,
      ...(Number.isFinite(compare) && compare > price ? { wasPrice: compare } : {}),
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

/** Next Store (Magento SSR) cards → hits via the shared search-side scanner. */
export function nextStoreHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const card of scanNextStoreCards(html)) {
    if (brandAwareCoverage(card.title, query) < MIN_SCORE) continue;
    out.push({
      title: card.title,
      merchant: "Next Store",
      country: "KW",
      ...(card.brand ? { brand: card.brand } : {}),
      price: card.price,
      currency: "KWD",
      url: card.url,
      inStock: card.inStock,
      ...(card.wasPrice != null ? { wasPrice: card.wasPrice } : {}),
    });
  }
  return out;
}

/** PC Kuwait (WooCommerce archive) cards → hits via the shared scanner. */
export function pcKuwaitHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const card of scanWooCards(html)) {
    if (brandAwareCoverage(card.title, query) < MIN_SCORE) continue;
    out.push({
      title: card.title,
      merchant: "PC Kuwait",
      country: "KW",
      price: card.price,
      currency: card.currency,
      url: card.url,
      inStock: card.inStock,
      ...(card.wasPrice != null ? { wasPrice: card.wasPrice } : {}),
    });
  }
  return out;
}

/**
 * PC Kuwait WooCommerce Store API v1 (`/wp-json/wc/store/v1/products`) JSON →
 * hits (REEA-272). The Store API is the challenge-tolerant endpoint for this
 * hop: it answers scripted requests on the first attempt without the CF
 * managed challenge, so the handshake is a fallback here rather than the
 * default. Prices arrive as minor-unit strings; `currency_minor_unit` is the
 * exponent that turns them into a decimal KWD amount.
 */
export function pcKuwaitApiHits(payload: unknown, query: string): SearchHit[] {
  const items = Array.isArray(payload) ? payload : [];
  const out: SearchHit[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const title = typeof item.name === "string" ? item.name : "";
    if (!title || brandAwareCoverage(title, query) < MIN_SCORE) continue;
    const prices = (item.prices ?? {}) as Record<string, unknown>;
    const exponent = Number(prices.currency_minor_unit);
    const minor = Number.isFinite(exponent) ? exponent : 2;
    const fromMinor = (raw: unknown): number | null => {
      const value = Number(raw);
      return Number.isFinite(value) ? value / 10 ** minor : null;
    };
    const price = fromMinor(prices.price);
    if (price == null) continue;
    const wasPrice = fromMinor(prices.regular_price);
    const images = Array.isArray(item.images) ? item.images : [];
    const firstImage = images[0] as Record<string, unknown> | undefined;
    const image = typeof firstImage?.src === "string" ? firstImage.src : undefined;
    out.push({
      title,
      merchant: "PC Kuwait",
      country: "KW",
      price,
      currency: typeof prices.currency_code === "string" ? prices.currency_code : "KWD",
      url: typeof item.permalink === "string" ? item.permalink : "https://pckuwait.com/",
      inStock: item.is_in_stock !== false,
      ...(wasPrice != null && wasPrice > price ? { wasPrice } : {}),
      ...(image ? { image } : {}),
    });
  }
  return out;
}

/** Lulu Hypermarket Kuwait: JSON-LD Product records off its SSR search page. */
export function luluHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const item of extractJsonLdProducts(html)) {
    if (brandAwareCoverage(item.title, query) < MIN_SCORE) continue;
    // The JSON-LD photo already rides `image` (normalized in the extractor);
    // it still passes the shared URL allowlist here like every scraped src.
    const img = pickImage(item);
    out.push({
      title: item.title,
      merchant: "Lulu Hypermarket",
      country: "KW",
      price: item.price,
      currency: item.currency ?? "KWD",
      url: item.url.startsWith("http") ? item.url : `https://www.luluhypermarket.com${item.url}`,
      inStock: item.inStock,
      ...(item.wasPrice != null ? { wasPrice: item.wasPrice } : {}),
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

/* ---- Fetch orchestration, one collector per documented retailer endpoint. ---- */

const COLLECTORS: RetailerCollector[] = [
  {
    merchant: "Xcite",
    country: "KW",
    collect: async (query, fetchImpl) => {
      const res = await fetchChecked(
        fetchImpl,
        "https://www.xcite.com/api/algolia/proxy",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requests: [
              { indexName: "xcite_prod_kw_en_main", params: { query, hitsPerPage: LIVE_SEARCH_HITS_PER_PAGE } },
            ],
          }),
        },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return xciteHits(await res.json(), query);
    },
  },
  {
    merchant: "Blink",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // suggest.json is the filter-aware Shopify hop: products.json ignores
      // its title parameter (answers a generic newest-products page), which
      // is what left blink/quadra coverage at 0–5 hits. Same hop for quadra.
      const res = await fetchChecked(
        fetchImpl,
        `https://blink.com.kw/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${LIVE_SEARCH_HITS_PER_PAGE}`,
        { headers: { accept: "application/json" } },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return blinkHits(await res.json(), query);
    },
  },
  {
    merchant: "Eureka",
    country: "KW",
    collect: async (query, fetchImpl) => {
      const signal = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      let appId, searchKey;
      const cached = readDiscovery("eureka");
      if (cached) {
        [appId, searchKey] = cached;
      } else {
        const page = await fetchChecked(
          fetchImpl,
          "https://www.eureka.com.kw/",
          { headers: { accept: "text/html" } },
          signal,
        );
        const html = await page.text();
        appId = html.match(/id="cky"[^>]*value="([^"]+)"/)?.[1];
        searchKey = html.match(/id="srcapk"[^>]*value="([^"]+)"/)?.[1];
        if (!appId || !searchKey) throw new Error("eureka credentials missing");
        if (!APP_ID_ALLOW.test(appId) || !SEARCH_KEY_ALLOW.test(searchKey)) {
          // Discovery failure: throw before writeDiscovery so nothing crafted
          // is cached and the next call re-discovers.
          throw new Error("eureka discovery credentials failed validation");
        }
        writeDiscovery("eureka", [appId, searchKey]);
      }
      const res = await fetchChecked(
        fetchImpl,
        `https://${appId}-dsn.algolia.net/1/indexes/instant_records/query` +
          `?x-algolia-application-id=${appId}&x-algolia-api-key=${searchKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=${LIVE_SEARCH_HITS_PER_PAGE}` }),
        },
        signal,
      );
      return eurekaHits(await res.json(), query);
    },
  },
  {
    merchant: "Sultan Center",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // Documented contract (captured live 2026-09-07 from the storefront's
      // own SPA): POST mobile/api/search with the store-scoped payload below;
      // answers {status:"1", products:{product_list:[…]}}.
      const res = await fetchChecked(
        fetchImpl,
        "https://www.sultan-center.com/mobile/api/search",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customerId: "",
            delivery_type: "home_delivery",
            currentpage: 1,
            filters: [],
            sortType: "position",
            currency: "KD",
            version: "eyJ2ZXJzaW9uX25hbWUiOiI3LjciLCJwbGF0Zm9ybSI6IklvcyJ9",
            substoreId: "45",
            store: 1,
            sortOrder: "asc",
            search_data: query,
            pagesize: LIVE_SEARCH_HITS_PER_PAGE,
            area: "",
            uid: null,
            deviceId: "reemco-web",
            is_web: 1,
            store_type: "ecom",
            latitude: "",
            longitude: "",
            isDesktop: "Desktop",
          }),
        },
        // The storefront answers slower than the Algolia-style endpoints
        // (observed ~4s under parallel load) — same doubled window as the
        // other two-step collectors above.
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2),
      );
      return sultanCenterHits(await res.json(), query);
    },
  },
  {
    merchant: "Jarir",
    country: "SA",
    collect: async (query, fetchImpl) => {
      const signal = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      // REEA-195 — the ar/en index choice follows the query script: Arabic
      // queries answer from jarir's Arabic index (correct titles + populated
      // brand), Latin queries keep the English index. Cached per language so
      // a warm instance still answers in one round-trip.
      const lang = jarirIndexLang(query);
      const cacheKey = `jarir:${lang}`;
      let indexKey = readDiscovery(cacheKey)?.[0];
      if (!indexKey) {
        const page = await fetchChecked(
          fetchImpl,
          "https://www.jarir.com/",
          { headers: { accept: "text/html" } },
          signal,
        );
        indexKey = extractJarirIndexKey(await page.text(), lang) ?? undefined;
        if (!indexKey) throw new Error("jarir index key missing");
        if (!SEARCH_KEY_ALLOW.test(indexKey)) {
          // Same discovery-failure semantics as the eureka hop: throw before
          // writeDiscovery so a crafted value never reaches cache or URL.
          throw new Error("jarir index key failed validation");
        }
        writeDiscovery(cacheKey, [indexKey]);
      }
      const res = await fetchChecked(
        fetchImpl,
        `https://ac.cnstrc.com/search/${encodeURIComponent(query)}` +
          `?key=${indexKey}&num_results_per_page=${LIVE_SEARCH_HITS_PER_PAGE}`,
        { headers: { accept: "application/json" } },
        signal,
      );
      return jarirHits(await res.json(), query);
    },
  },
  {
    merchant: "Amazon.eg",
    country: "EG",
    collect: async (query, fetchImpl) => {
      // Amazon.eg answers the edge with two transient shapes: the apology
      // interstitial (HTTP 200, no cards) and an occasional hard HTTP 503.
      // The 503 shape used to throw straight out of fetchChecked, skipping
      // the retry loop entirely — one blip dropped Amazon.eg from the whole
      // page. Both shapes now retry once after a short polite pause (REEA-93
      // keeps its two bounded attempts): attempt + backoff + attempt fits the
      // same TIMEOUT×2 two-step window the jarir/eureka chains use, so the
      // REEA-156 budget arithmetic is unchanged. When both attempts fail the
      // last error still surfaces, keeping the per-merchant note diagnosable.
      let hits: SearchHit[] = [];
      let lastError: unknown;
      for (let attempt = 0; attempt < 2 && hits.length === 0; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, AMAZON_RETRY_BACKOFF_MS));
        try {
          const res = await fetchChecked(
            fetchImpl,
            `https://www.amazon.eg/s?k=${encodeURIComponent(query)}`,
            {
              headers: {
                accept: "text/html,application/xhtml+xml",
                "accept-language": "en",
                "user-agent": "Mozilla/5.0",
              },
            },
            AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
          );
          hits = amazonEgHits(await res.text(), query);
          lastError = undefined;
        } catch (err) {
          lastError = err;
        }
      }
      if (hits.length === 0 && lastError) throw lastError;
      return hits;
    },
  },
  {
    merchant: "Quadra Stores",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // Shopify contract, same shape as blink's hop (verified live 2026-09-08).
      const res = await fetchChecked(
        fetchImpl,
        `https://quadrastores.com/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${LIVE_SEARCH_HITS_PER_PAGE}`,
        { headers: { accept: "application/json" } },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return quadraHits(await res.json(), query);
    },
  },
  {
    merchant: "Next Store",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // Magento SSR search page behind a Cloudflare managed challenge (verified
      // live 2026-09-08): the interstitial steps aside within the hop window —
      // the verified-crawler identity clears the CF rules on the first attempt,
      // the scripted-browser set follows on odd attempts — so this hop rides
      // fetchThroughChallenge's bounded identity-alternating retry without its
      // own header set. The attempt window mirrors eureka's two-step hop — the
      // challenge handshake needs a little more room than a plain API answer.
      const res = await fetchThroughChallenge(
        fetchImpl,
        `https://www.nextstore.com.kw/catalogsearch/result/index/?q=${encodeURIComponent(query)}`,
        {},
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2),
      );
      return nextStoreHits(await res.text(), query);
    },
  },
  {
    merchant: "PC Kuwait",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // REEA-272: lead with the WooCommerce Store API JSON (`/wp-json/wc/
      // store/v1/products`) — the challenge-tolerant endpoint the brief calls
      // for. It answers even a bare accept-only request on the first attempt
      // without the CF managed challenge (verified live 2026-09-08 from cold
      // datacenter egress), while the HTML archive still needs an identity
      // handshake. If the JSON hop can't answer, fall back to the
      // `post_type=product` archive page (prices + stock; the plain blog
      // search view carries neither) over the identity-alternating handshake
      // the other CF-fronted stores get, with its doubled window.
      const apiUrl = `https://pckuwait.com/wp-json/wc/store/v1/products?search=${encodeURIComponent(query)}&per_page=${LIVE_SEARCH_HITS_PER_PAGE}`;
      // Cached first: with an explicit `force-cache` + bounded revalidate the
      // Next data cache keeps the JSON payload across serverless invocations
      // even inside the force-dynamic results segment (REEA-272 option 2 —
      // cache that persists across invocations), so one answered hop keeps
      // the adapter serving hits while later cold instances re-run behind
      // the revalidate window. Both JSON attempts share ONE hop window, so
      // the chain costs at most what the other CF-fronted hops pay; only a
      // cache miss with a squeezed window falls to the archive page below.
      const jsonWindow = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS);
      try {
        const cached = await fetchImpl(apiUrl, {
          headers: { accept: "application/json" },
          cache: "force-cache",
          next: { revalidate: 300 },
          signal: jsonWindow,
        } as RequestInit);
        if (cached.ok) return pcKuwaitApiHits(JSON.parse(await cached.text()), query);
      } catch {
        // Cache-first miss (or a squeezed window) — the uncached JSON attempt
        // inside the same window answers with the same payload shape.
      }
      try {
        const jsonRes = await fetchThroughChallenge(
          fetchImpl,
          apiUrl,
          {},
          jsonWindow,
        );
        if (jsonRes.ok) return pcKuwaitApiHits(JSON.parse(await jsonRes.text()), query);
      } catch {
        // Malformed JSON or the window spent — the archive page below
        // answers with the same data shape.
      }
      const res = await fetchThroughChallenge(
        fetchImpl,
        `https://pckuwait.com/?s=${encodeURIComponent(query)}&post_type=product`,
        {},
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2),
      );
      return pcKuwaitHits(await res.text(), query);
    },
  },
  {
    merchant: "Lulu Hypermarket",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // Kuwait storefront — luluwebstore.com is a plain 301 onto this host,
      // so this is the one that answers Kuwait prices. JSON-LD comes off the
      // SSR search page; same identity-alternating managed-challenge retry
      // as the Next Store hop (verified live 2026-09-08), and on a still-
      // blocked answer the note explains the gap while the other retailers
      // serve (graceful degradation).
      const res = await fetchThroughChallenge(
        fetchImpl,
        `https://www.luluhypermarket.com/en/search?query=${encodeURIComponent(query)}`,
        {},
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2),
      );
      return luluHits(await res.text(), query);
    },
  },
];

/**
 * Group raw retailer hits into one product per canonical key (REEA-167 §1–2).
 * Each live title is reduced to its brand|model_line|storage|color|grade
 * tuple, offers are grouped by compatible-equality of those tuples — a subset
 * key joins the matching group (into the cheapest one when several match),
 * distinct tuples never blend — so the same device listed under two title
 * spellings lands on one card carrying the UNION of offers, cheapest first.
 * Titles are kept verbatim; the card shows the member title with the fewest
 * tokens (tie-break alphabetically smallest slug) as the canonical view title.
 * REEA-254 adds two things on top: the merge pass runs over adapter-rank-
 * ordered hits so consecutive loads of the same fetched set converge on the
 * identical card set, and colors join INSIDE one model+storage card (as
 * per-color best-price swatches) instead of splitting into per-color cards.
 */
export function groupHits(
  query: string,
  hits: SearchHit[],
  includeAlternatives = true,
): NormalizedProduct[] {
  const groups = buildGroups(query, hits);
  return finalizeGroups(rankByRelevance(query, groups), includeAlternatives);
}

/**
 * REEA-213 — relevance-first ranking (Bet 1, REEA-211 brief): tier blocks
 * 1→4 decide the order and are never blended by price; price only breaks
 * ties inside a block. Inside a block: non-extended model match before
 * model-extended ("iPhone 17 Pro" before "iPhone 17 Pro Max" on
 * `iPhone 17 Pro`), named brand before blank/generic, effective price
 * ascending with only in-stock cards participating unless the whole block is
 * out of stock, stable adapter arrival order last. The REEA-137 breadth
 * round-robin and the REEA-195 Arabic brand lead run INSIDE each tier block —
 * both preserve relative order of their input, so blocks stay contiguous
 * through the selection and the tier ladder holds.
 */
function rankByRelevance(query: string, groups: HitGroup[]): HitGroup[] {
  type Ranked = {
    group: HitGroup;
    arrival: number;
    tier: number;
    extended: boolean;
    named: boolean;
    stocked: boolean;
    cheapest: number;
  };
  const ranked: Ranked[] = groups.map((group, arrival) => {
    // A merged card qualifies through ANY of its member titles; the visible
    // extended-match flag reads the canonical title the card actually shows.
    const canonical = canonicalGroupTitle(group);
    const metadata = `${group.brandRaw} ${group.offers.map((o) => o.merchant).join(" ")}`;
    let tier = Infinity;
    for (const t of group.titles) tier = Math.min(tier, relevanceTier(query, t, metadata));
    if (!Number.isFinite(tier)) tier = relevanceTier(query, canonical, metadata);
    return {
      group,
      arrival,
      tier,
      extended: isModelExtended(query, canonical),
      named: brandIsNamed(group.brandRaw || undefined, canonical),
      stocked: group.offers.some((o) => o.inStock),
      // REEA-254 item B/D: best effective price of the card — KWD-space so
      // mixed-currency cards rank on one scale.
      cheapest: Math.min(...group.offers.map((o) => toKwdNumeric(o.price, o.currency))),
    };
  });
  const insideTier = (a: Ranked, b: Ranked): number =>
    Number(a.extended) - Number(b.extended) ||
    Number(!a.named) - Number(!b.named) ||
    Number(!a.stocked) - Number(!b.stocked) ||
    a.cheapest - b.cheapest ||
    a.arrival - b.arrival;

  const buckets: Ranked[][] = [];
  for (const r of ranked) {
    // REEA-222: a tier-0 group (zero query-token coverage) is the WEAKEST
    // match and joins the bottom bucket. Clamping it into the lead bucket
    // let a cheap cross-category card (an Instax camera at KWD 44 under
    // `iPhone 17 Pro Max`) outrank every phone on the inside-tier price
    // tiebreak and steal the single Best-price badge. Unknown/absent tiers
    // (Infinity) keep their old home — the last matched block.
    const idx = r.tier >= 1 && r.tier <= 4 ? r.tier - 1 : 4;
    (buckets[idx] ??= []).push(r);
  }
  const out: HitGroup[] = [];
  for (const bucket of buckets) {
    // Empty tier blocks are holes in the buckets array — skip them, the
    // later blocks still contribute while the slice budget lasts.
    if (!bucket) continue;
    if (out.length >= LIVE_SEARCH_MAX_PRODUCTS) break;
    bucket.sort(insideTier);
    const block = bucket.map((r) => r.group);
    out.push(
      ...selectAcrossRetailers(
        leadWithBrandMatch(block, query),
        LIVE_SEARCH_MAX_PRODUCTS - out.length,
      ),
    );
  }
  return out;
}

/**
 * REEA-195 — brand-match lead for Arabic brand queries: when the Arabic query
 * carries an explicit brand token ("سماعة أبل" → Apple), groups whose titles
 * carry that brand lead the list; everything keeps its relative order inside
 * both buckets. This is a partition, not a synonym/taxonomy expansion — a
 * query without a brand token returns the list untouched, and Latin-only
 * queries never enter this path. Without it the symmetric fit score (higher
 * for same-script titles) keeps ranking Arabic-script AABLE-style Quran
 * listings — whose only link to the query is the same "أبل" spelling — above
 * the actual Apple devices the shopper asked for.
 */
function leadWithBrandMatch(groups: HitGroup[], query: string): HitGroup[] {
  const brand = arabicBrandIntent(query);
  if (!brand) return groups;
  const matched = groups.filter((g) => [...g.titles].some((t) => titleMatchesBrand(t, brand)));
  if (matched.length === 0 || matched.length === groups.length) return groups;
  return [...matched, ...groups.filter((g) => !matched.includes(g))];
}

/** Fixed adapter rank per merchant from the COLLECTORS order. Unknown
 *  merchants (injectable test parsers) land after the known ones in arrival
 *  order — still deterministic for a given fetched set. */
function adapterRank(merchant: string): number {
  const i = COLLECTORS.findIndex((c) => c.merchant === merchant);
  return i < 0 ? COLLECTORS.length : i;
}

/**
 * REEA-254 — stable pre-order for the grouping pass. Adapter completion order
 * changes between consecutive loads, so an arrival-order grouping made the
 * merge itself load-dependent. Sorting into the fixed COLLECTORS order (the
 * explicit arrival-index tie-break keeps each adapter's payload order inside
 * its rank) makes grouping a pure function of the fetched SET: same input,
 * same merge, every load. The title→tuple mapping itself is cached in
 * canonical-product: same title, same tuple, every load.
 */
function orderByAdapter(hits: SearchHit[]): SearchHit[] {
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => adapterRank(a.h.merchant) - adapterRank(b.h.merchant) || a.i - b.i)
    .map((x) => x.h);
}

/** REEA-254 merge decision. One card per model+storage tier: colors ride
 *  inside the card as swatches (see colorSwatches), so they never split the
 *  merge — storage tiers, model lines and grades still discriminate. The
 *  too-generic guard still reads colors when neither side carries a model
 *  line or storage value: there the color IS the visible variant label. */
function mergeCompatible(a: CanonicalFields, b: CanonicalFields): boolean {
  if (!compatibleFields({ ...a, color: "" }, { ...b, color: "" })) return false;
  if (a.modelLine === "" && b.modelLine === "" && a.storage === "" && b.storage === "") {
    return compatibleFields(a, b);
  }
  return true;
}

function buildGroups(query: string, hits: SearchHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  // REEA-254 item B — every cheapest comparison runs in KWD-space: a SAR
  // listing and a KWD listing on one card must compete on the same scale.
  const cheapestOf = (g: HitGroup): number =>
    Math.min(...g.offers.map((o) => toKwdNumeric(o.price, o.currency)));

  for (const hit of orderByAdapter(hits)) {
    const title = hit.title.trim();
    if (!title) continue;
    const fields = canonicalFields(title);
    // REEA-192 — product-class gate: an accessory-class title (case / cover /
    // protector / tempered glass / film / skin; كفر، جراب، واقي، غطاء) never
    // folds into the device's card. Accessory nouns often sit BEFORE the brand
    // token, where the model-line scan never sees them, so the field tuple
    // alone lets a case merge into the phone it fits — the badge then lands
    // on the accessory price while the phone rows sit below it. The class
    // rides the group and gates every merge; accessory hits form their own
    // groups and reach their own tier through partitionForQuery (REEA-180
    // Rule 2 tiering, shipped by REEA-189).
    const accessory = isAccessoryTitle(title);
    // Partial-match rule: every candidate group whose non-empty fields agree
    // is eligible; join the one holding the lowest-priced offer so the best
    // effective price always wins the merge. Same-class groups only.
    let chosen: HitGroup | undefined;
    for (const g of groups) {
      if (g.accessory !== accessory) continue;
      if (!mergeCompatible(g.fields, fields)) continue;
      if (!chosen || cheapestOf(g) < cheapestOf(chosen)) chosen = g;
    }
    if (!chosen) {
      // The tuple comes from a shared cache — copy before the group seeds it.
      chosen = { fields: { ...fields }, accessory, titleScore: 0, titles: new Set<string>(), offers: [], brandRaw: hit.brand ?? "" };
      groups.push(chosen);
    } else {
      // REEA-168 follow-up (board note on REEA-169): seed the group's missing
      // fields from the incoming offer on merge. Storage stays the card-
      // splitting discriminator (REEA-254): a later offer of another capacity
      // forms its own group instead of leaking into this ranked list; offers
      // still missing that field keep joining through the partial-match rule.
      const f = chosen.fields;
      if (f.modelLine === "") f.modelLine = fields.modelLine;
      if (f.storage === "") f.storage = fields.storage;
      if (f.color === "") f.color = fields.color;
      // REEA-189: same seed rule for the retailer brand field — first non-empty
      // wins so a retailer that ships brands fills the card chip even when the
      // cheapest-hit retailer's payload carries none.
      if (chosen.brandRaw === "" && hit.brand) chosen.brandRaw = hit.brand;
    }
    const score = titleMatchScore(title, query);
    if (score > chosen.titleScore) chosen.titleScore = score;
    chosen.titles.add(title);
    // Union preservation: distinct listings stay distinct rows; only an exact
    // same merchant+price+listing is the same offer arriving twice.
    if (
      !chosen.offers.some(
        (o) => o.merchant === hit.merchant && o.price === hit.price && o.url === hit.url,
      )
    ) {
      chosen.offers.push(hit);
    }
  }
  return groups;
}

/**
 * Canonical slug selection (REEA-167 §2): the member title with the fewest
 * tokens, tie-break the alphabetically smallest slug — identical however
 * the shopper arrived, so every spelling of the same device lands on one
 * stable view and old links converge instead of forking. Shared by the
 * ranking pass (the visible card decides the extended-match flag) and the
 * finalization below.
 */
function canonicalGroupTitle(group: HitGroup): string {
  let title = "";
  let titleTokens = Infinity;
  let titleSlug = "";
  for (const t of group.titles) {
    const tokens = t.split(/\s+/).length;
    const slug = slugify(t);
    if (tokens < titleTokens || (tokens === titleTokens && slug < titleSlug)) {
      title = t;
      titleTokens = tokens;
      titleSlug = slug;
    }
  }
  return title;
}

/** REEA-254 color swatches — when a merged card's offers carry more than one
 *  color, each color gets its own best-price chip. The color's best minus the
 *  card's best rides in `priceDelta` so the card renders the absolute figure;
 *  one color (or none) keeps the plain single-price card. Sorted cheapest
 *  first, color name as the alphabetical tie-break.
 *  REEA-254 item B: every comparison here runs on KWD-space numerics
 *  (toKwdNumeric), so a colour whose only listing is SAR-priced is compared —
 *  and its delta computed — on the same scale as the KWD listings. Raw
 *  numerics bridged straight into `priceDelta` made a SAR figure read as a
 *  KWD figure on the chip (live QA case: Blue/Silver "KWD 6,199.000" beside
 *  Cosmic "KWD 419.900" on one card). */
function colorSwatches(group: HitGroup, offers: PriceOffer[]): ProductVariation[] {
  const colorBest = new Map<string, number>();
  for (const o of group.offers) {
    const color = canonicalFields(o.title).color;
    if (color === "") continue;
    const value = toKwdNumeric(o.price, o.currency);
    const prev = colorBest.get(color);
    if (prev === undefined || value < prev) colorBest.set(color, value);
  }
  if (colorBest.size < 2) return [];
  const cardBest = Math.min(...offers.map((o) => toKwdNumeric(o.price, o.currency)));
  return [...colorBest.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([color, price]) => ({
      id: color,
      label: color.charAt(0).toUpperCase() + color.slice(1),
      // Cent-rounded KWD-space difference: currency arithmetic stays readable
      // on the wire (25.1, not the float-sum 25.100000000000023).
      priceDelta: Math.round((price - cardBest) * 100) / 100,
    }));
}

function finalizeGroups(selected: HitGroup[], includeAlternatives: boolean): NormalizedProduct[] {
  const scrapedAt = new Date().toISOString(); // real collection completion time

  // REEA-254 payload trim — shared alternatives. Every card's row list
  // re-references ONE computed entry per referenced group, and a group that
  // sits outside the top three shares the single top-three array itself.
  // The RSC flight payload serializes each distinct object once and refers to
  // it afterwards, so the repeated per-row arrays collapse from ~20×3 entries
  // to a handful of distinct ones. Same content as before: top-ranked other
  // groups, self excluded, fromPrice = that group's cheapest live offer.
  const metas = new Map<HitGroup, ProductAlternative>();
  const metaOf = (g: HitGroup): ProductAlternative => {
    let m = metas.get(g);
    if (!m) {
      const otherTitle = canonicalGroupTitle(g);
      m = {
        productId: slugify(otherTitle),
        title: otherTitle,
        // KWD-space numeric (REEA-254 item B): alternatives rows render this
        // through formatPrimaryPrice(x, "KWD"), so mixed-currency groups show
        // the cheapest-after-conversion figure, not whichever raw numeric is
        // smallest.
        fromPrice: Math.min(...g.offers.map((o) => toKwdNumeric(o.price, o.currency))),
      };
      metas.set(g, m);
    }
    return m;
  };
  const topGroups = selected.slice(0, 3);
  const sharedTop: ProductAlternative[] = topGroups.map(metaOf);
  const alternativesFor = (group: HitGroup): ProductAlternative[] => {
    if (!topGroups.includes(group)) return sharedTop;
    // A top-three row still excludes itself — a small array of shared entries.
    return selected.filter((other) => other !== group).slice(0, 3).map(metaOf);
  };

  return selected.map((group, idx) => {
    const title = canonicalGroupTitle(group);
    const offers: PriceOffer[] = [...group.offers]
      // Cheapest offer first in KWD-space (REEA-167 §2 + REEA-254 item B);
      // purchasable offers break ties. Within one currency the order is the
      // scraped order — the conversion only aligns figures ACROSS currencies.
      .sort(
        (a, b) =>
          toKwdNumeric(a.price, a.currency) - toKwdNumeric(b.price, b.currency) ||
          Number(b.inStock) - Number(a.inStock),
      )
      // REEA-192 — one row per retailer in the card: the sorted-first offer
      // is that retailer's best matched-product price; further listings from
      // the same merchant are variants of one comparison row, not new rows,
      // and stacking them buries the badge under repeated merchants.
      .filter(
        (o, i, arr) => arr.findIndex((x) => x.merchant === o.merchant) === i,
      )
      .map((o) => {
        const grade = canonicalFields(o.title).grade;
        return {
          merchant: o.merchant,
          price: o.price,
          currency: o.currency,
          url: o.url,
          inStock: o.inStock,
          ...(o.wasPrice != null ? { wasPrice: o.wasPrice } : {}),
          ...(grade !== "new" ? { grade } : {}),
          // REEA-281 AC-1: each retailer's own listing photo rides its row;
          // rows whose contract carries no photo simply have none (the card
          // then renders its text-only fallback).
          ...(o.image ? { image: o.image } : {}),
        };
      });
    // REEA-281 AC-1: the card thumbnail is the FIRST member listing that
    // actually carries a photo — live hits only, never invented.
    const photo = offers.find((o) => o.image)?.image;
    return {
      productId: slugify(title) || `live-${idx}`,
      title,
      brand: resolveBrand(group.brandRaw, title),
      ...(photo ? { image: photo } : {}),
      offers,
      coupons: [],
      variations: colorSwatches(group, offers),
      alternatives: includeAlternatives ? alternativesFor(group) : [],
      scrapedAt,
    } satisfies NormalizedProduct;
  });
}

type HitGroup = { fields: CanonicalFields; accessory: boolean; titleScore: number; titles: Set<string>; offers: SearchHit[]; brandRaw: string };

/**
 * REEA-137 — fill the served slice round-robin across retailers instead of a
 * plain top-N slice of the score ranking. On one-word brand queries every
 * retailer's hits clear relevance, and the symmetric fit-score ranks short
 * titles above verbose ones; a pure slice then lets the two fastest responders
 * occupy all slots (samsung served Xcite + Eureka only even though Jarir and
 * Amazon.eg had collected hits). Round-robin over the fixed collector order
 * keeps relevance order inside each retailer's queue while guaranteeing the
 * page breadth the >=3-retailer requirement asks for. Groups shared by several
 * retailers serve from whichever queue reaches them first.
 */
function selectAcrossRetailers(sorted: HitGroup[], limit: number): HitGroup[] {
  const queues = new Map<string, HitGroup[]>();
  for (const group of sorted) {
    for (const merchant of new Set(group.offers.map((o) => o.merchant))) {
      let queue = queues.get(merchant);
      if (!queue) queues.set(merchant, (queue = []));
      if (!queue.includes(group)) queue.push(group);
    }
  }
  const order = COLLECTORS.map((c) => c.merchant).filter((m) => queues.has(m));
  for (const merchant of queues.keys()) if (!order.includes(merchant)) order.push(merchant);

  const selected: HitGroup[] = [];
  const seen = new Set<HitGroup>();
  let progressed = true;
  while (progressed && selected.length < limit) {
    progressed = false;
    for (const merchant of order) {
      const queue = queues.get(merchant);
      if (!queue) continue;
      const next = queue.shift();
      if (!next) continue;
      progressed = true;
      if (!seen.has(next)) {
        seen.add(next);
        selected.push(next);
        if (selected.length >= limit) break;
      }
    }
  }
  return selected;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface LiveSearchResult {
  products: NormalizedProduct[];
  /** Per-retailer notes for the diagnostics panel; failures included. */
  notes: { merchant: string; hits: number; error?: string }[];
  /** Empty-match suggestion set (REEA-114); every snapshot carries its own. */
  suggestions?: NormalizedProduct[];
}

/**
 * REEA-290 — the per-query coverage sentence the results page states in plain
 * text: which retailers answered this search and which did not, straight from
 * the run's own notes (no second fetch, no bundled registry — a note is only
 * ever written by the live fan-out that produced the offers on screen).
 * Names follow the fixed COLLECTORS order (REEA-254 determinism: the same
 * settled set reads as the same sentence on consecutive loads, whatever the
 * completion order was). A retailer that answered with zero matching hits DID
 * respond — its empty shelf is an answer, not a gap — so only notes carrying
 * an error land on the "did not respond" side. An empty notes list (nothing
 * collected yet) yields an empty string: no line, no flicker.
 */
export function coverageLine(notes: LiveSearchResult["notes"], locale?: "en" | "ar"): string {
  const ordered = [...notes].sort(
    (a, b) => adapterRank(a.merchant) - adapterRank(b.merchant),
  );
  const failed: string[] = [];
  const answered: string[] = [];
  for (const n of ordered) {
    (n.error ? failed : answered).push(n.merchant);
  }
  // REEA-279: the two sentence shapes live in the static table so the stamp
  // matches the shell language; EN keeps the exact figures it had before.
  const ar = locale === "ar";
  const parts: string[] = [];
  if (failed.length > 0)
    parts.push(ar ? `${joinNames(failed, ar)} لم يستجب لهذا البحث.` : `${joinNames(failed)} did not respond on this search.`);
  if (answered.length > 0)
    parts.push(ar ? `أسعار من ${joinNames(answered, ar)}.` : `Prices from ${joinNames(answered)}.`);
  return parts.join(" ");
}

/** Plain-text name list: "Xcite" / "Xcite and Blink" / "Xcite, Blink and Eureka". */
function joinNames(names: string[], ar = false): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}${ar ? " و" : " and "}${names[names.length - 1]}`;
}

/**
 * REEA-178 — progressive per-retailer collection for the results page.
 * One promise per adapter in the run; stage k settles when at least k+1
 * adapters have answered (in completion order) and carries the merged-so-far
 * snapshot, so each flush is append-only over the previous one. The final
 * stage deepens silent merchants first (REEA-149 round two) and then serves
 * the exact full-ranked snapshot the blocking path produces — both paths
 * share one finish, one live fetch per adapter, no bundled snapshots.
 *
 * REEA-277 — two changes on top of that shape:
 *  - the arrival gate is per retailer again (stage k opens as the (k+1)-th
 *    adapter answers) instead of REEA-244's whole-round-one hold, so the
 *    first price lands with the FIRST answer instead of behind the slowest
 *    hop. Every flush still renders the full tier ladder over everything
 *    answered so far (stagedSnapshot), and the converged final stage carries
 *    the same full-ranked view the blocking path produces,
 *  - a per-query short-TTL response cache (src/lib/query-cache.ts) fronts
 *    the run: repeat identical queries inside the window serve the LAST LIVE
 *    answer as fully-settled stages, with one bounded refresh running behind
 *    the response in the stale window (stale-while-revalidate). Entries only
 *    ever hold responses a live fan-out just produced — scrapedAt rides
 *    along, so freshness chips keep showing the true collection time.
 */
export interface LiveSearchStages {
  stages: Promise<LiveSearchResult>[];
  /** Same promise as the last stage: the converged full-ranked snapshot. */
  final: Promise<LiveSearchResult>;
}

type SettledAdapter = { merchant: string; hits: SearchHit[]; error?: string };

/**
 * REEA-290 — every failing adapter gets one bounded retry before render,
 * riding the same polite pause the amazon.eg hop pioneered (REEA-149): a
 * single 403/503 blip or a momentary timeout should not drop a retailer from
 * the coverage line when its very next attempt answers fine. The pause keeps
 * the retry polite to the retailer's rate limiter, and the whole chain stays
 * inside LIVE_SEARCH_BUDGET_MS because every hop still carries its own joined
 * attempt window (joinSignals). Adapters that already run their own bounded
 * internal loops (amazon.eg's empty-answer attempts, fetchThroughChallenge's
 * cookie-carry handshake) keep them — this wrapper only adds the second shot
 * a plain throw never had. Amazon.eg throws only after BOTH of its attempts
 * failed, so its worst case stays within the budget the signal enforces.
 */
async function collectSettled(
  c: RetailerCollector,
  q: string,
  fetchImpl: FetchImpl,
): Promise<SettledAdapter> {
  const asError = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  try {
    return { merchant: c.merchant, hits: await c.collect(q, fetchImpl) };
  } catch (err) {
    const firstError = asError(err);
    await new Promise((r) => setTimeout(r, AMAZON_RETRY_BACKOFF_MS));
    try {
      return { merchant: c.merchant, hits: await c.collect(q, fetchImpl) };
    } catch (retryErr) {
      // Both attempts down: report the LAST error — it is the state the
      // final snapshot actually served. Fall back to the first message when
      // the retry produced only an empty abort reason.
      return {
        merchant: c.merchant,
        hits: [],
        error: asError(retryErr) || firstError,
      };
    }
  }
}

/** Shared filter+notes pass — adapter country tag wins before grouping. */
function filterNotes(
  country: CountryCode | null,
  settledSoFar: SettledAdapter[],
): { hits: SearchHit[]; notes: LiveSearchResult["notes"] } {
  const hits: SearchHit[] = [];
  const notes: LiveSearchResult["notes"] = [];
  for (const s of settledSoFar) {
    // Defensive second match on the adapter tag (parsers are injectable in
    // tests); with scoped collectors this is already a tautology.
    const kept = country ? s.hits.filter((h) => h.country === country) : s.hits;
    hits.push(...kept);
    notes.push({ merchant: s.merchant, hits: kept.length, ...(s.error ? { error: s.error } : {}) });
  }
  return { hits, notes };
}

/**
 * Intermediate flush: same full relevance ranking as the converged snapshot
 * (REEA-222). Append-only still holds at StageAppend's diff level — earlier
 * cards keep their slots and each flush only renders the not-yet-seen cards —
 * but within every flushed block the tier ladder leads, so the streamed SSR
 * shell shows phones above cross-category filler and the single Best-price
 * badge lands on the lead block's cheapest in-stock card without waiting for
 * client hydration (QA REEA-240 re-run: with insertion-order flushes the
 * camera-first arrival order of the fastest retailer was what curl-only
 * inspection ever saw).
 */
function stagedSnapshot(
  q: string,
  country: CountryCode | null,
  settledSoFar: SettledAdapter[],
): LiveSearchResult {
  const { hits, notes } = filterNotes(country, settledSoFar);
  // REEA-254 payload trim: intermediate flushes render through the card
  // variant, which never reads `alternatives`; the converged snapshot carries
  // the shared row list. Every staged flush re-serialized the same arrays.
  const products = groupHits(q, hits, false);
  return { products, notes, suggestions: products.slice(0, 3) };
}

/**
 * REEA-149 depth pass: retailers that contributed nothing in round one are
 * queried once more under the normalized query form. Additive only — an
 * existing offer never depends on this round, and when every merchant already
 * answered there is nothing to deepen, so it stays a single round. Runs
 * inside the FINAL stage only, so mid-stream flushes stay single-hop.
 */
async function deepenSilent(
  q: string,
  settled: SettledAdapter[],
  fetchImpl: FetchImpl,
): Promise<void> {
  const firstHits: SearchHit[] = [];
  for (const s of settled) firstHits.push(...s.hits);
  const missing = settled.filter((s) => s.hits.length === 0);
  if (firstHits.length === 0 || missing.length === 0) return;
  const enriched = enrichedQuery(firstHits, q);
  if (!enriched || enriched.toLowerCase() === q.toLowerCase()) return;
  await Promise.all(
    missing.map(async (s) => {
      const collector = COLLECTORS.find((c) => c.merchant === s.merchant);
      if (!collector) return;
      try {
        const hits = await collector.collect(enriched, fetchImpl);
        if (hits.length > 0) {
          s.hits = hits;
          s.error = undefined;
        }
      } catch {
        // Second attempt failed too — keep the round-one note as-is.
      }
    }),
  );
}

/** Converged snapshot: full groupHits ranking + relaxed-query suggestions. */
async function finalSnapshot(
  q: string,
  country: CountryCode | null,
  settled: SettledAdapter[],
  fetchImpl: FetchImpl,
): Promise<LiveSearchResult> {
  const { hits, notes } = filterNotes(country, settled);
  const products = groupHits(q, hits);
  let suggestions = products.slice(0, 3);
  if (q && products.length === 0) {
    // Zero matches: re-collect once with the leading token so the empty state
    // suggests real live titles, not catalog fixtures.
    const relaxed = q.split(/\s+/)[0] ?? q;
    if (relaxed && relaxed !== q) {
      suggestions = (await collectLiveResults(relaxed, { fetchImpl, country })).products.slice(0, 3);
    }
  }
  return { products, notes, suggestions };
}

/** Options shared by the staged and blocking collection entries. */
export interface StagedCollectOptions {
  fetchImpl?: FetchImpl;
  country?: CountryCode | null;
  signal?: AbortSignal;
  /** Response-cache override for this run (tests, diagnostics). */
  cache?: QueryCache;
  /** REEA-291 AC4 — explicit Refresh: never take the fresh-window shortcut.
   *  A cached answer still serves as the first flush (stale path), but the
   *  live fan-out always re-runs behind it so collection timestamps update. */
  refresh?: boolean;
}

/** Always-miss cache used when the caller injects its own fetchImpl: a
 *  diagnostic chain must observe every hop it declares, not a previous run's
 *  answer. Production calls (no fetchImpl) get the shared live cache. */
const NO_CACHE: QueryCache = {
  read: () => null,
  write: () => {},
  size: () => 0,
  reset: () => {},
};

export function collectLiveResultsStaged(
  query: string,
  opts: StagedCollectOptions = {},
): LiveSearchStages {
  const baseFetch: FetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  // REEA-224 F4 — thread the overall budget signal into every hop: each hop
  // still carries its own attempt window, whichever expires first aborts.
  const budget = opts.signal;
  const fetchImpl: FetchImpl = budget
    ? (u, init) => baseFetch(u, { ...init, signal: joinSignals(budget, init?.signal ?? undefined) })
    : baseFetch;
  const q = query.trim();
  const country = opts.country ?? null;
  const collectors = country
    ? COLLECTORS.filter((c) => c.country === country)
    : COLLECTORS;
  const cache = opts.cache ?? (opts.fetchImpl ? NO_CACHE : defaultQueryCache);
  // REEA-291 AC5 — memo identity is the NORMALIZED QUERY STRING ONLY: the
  // collected answer is per query; viewer-side selections filter the loaded
  // payload at render time (ResultsClient), never fork the memo.
  const cacheKey = queryCacheKey(q);

  // REEA-277 AC-2 — stale-while-revalidate in front of the fan-out. Entries
  // only ever hold responses a live fan-out produced (scrapedAt and the
  // per-note merchant stamps ride along untouched, so freshness chips keep
  // showing the true collection time of what is on screen).
  //  - fresh entry: serve the last live answer immediately, no hop at all —
  //    this is the AC-2 repeat-within-5-minutes case;
  //  - stale entry: the cached snapshot still serves as the first flush while
  //    the live run below continues behind the response and its staged
  //    flushes deepen the page (classic stale-while-revalidate);
  //  - miss/expiry (past the ≤15-min ceiling): plain live path.
  // REEA-291 AC4 — behind the explicit Refresh action (opts.refresh) a fresh
  // entry degrades to the stale path: the cached snapshot is still the first
  // flush, but the live fan-out ALWAYS re-runs behind it, so the converged
  // write-through carries new scrapedAt stamps to the freshness chips.
  const hit = cache.read<LiveSearchResult>(cacheKey);
  const cached: QueryCacheHit<LiveSearchResult> | null =
    hit && opts.refresh && !hit.stale ? { ...hit, stale: true } : hit;
  if (cached && !cached.stale) {
    const served = Promise.resolve(cached.value);
    return { stages: [served], final: served };
  }

  // Round one: every retailer is contacted once, in parallel, at call time —
  // same single request per retailer as the blocking path, same bounded
  // per-collector timeouts (REEA-156). Completions append to the accumulator
  // in arrival order and each stage opens on its OWN arrival threshold
  // (REEA-277): stage k releases when the (k+1)-th retailer answers, so the
  // first price lands with the FIRST answer instead of behind the slowest hop
  // (the whole-round-one hold REEA-244 added). Ranking is not lost by starting
  // early: every intermediate flush renders the full tier ladder over
  // everything answered so far (stagedSnapshot), and the FINAL stage carries
  // the same full-ranked converged view the blocking path produces — one live
  // fetch per retailer is shared by both paths, no bundled snapshot.
  const settled: SettledAdapter[] = [];
  const waiting: Array<{ need: number; resolve: () => void }> = [];
  function wakeReady(): void {
    // Each completion checks the pending thresholds; a waiter only leaves the
    // queue when its own count is met, so early flushes stay smallest-first.
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (settled.length >= waiting[i].need) {
        const w = waiting[i];
        waiting.splice(i, 1);
        w.resolve();
      }
    }
  }
  function untilArrivals(need: number): Promise<void> {
    const target = Math.min(need, collectors.length);
    if (settled.length >= target) return Promise.resolve();
    return new Promise<void>((resolve) => waiting.push({ need: target, resolve }));
  }

  for (const c of collectors) {
    void collectSettled(c, q, fetchImpl).then((s) => {
      settled.push(s);
      wakeReady();
    });
  }

  const stages: Promise<LiveSearchResult>[] = collectors.map(async (_c, k) => {
    await untilArrivals(k + 1);
    if (k < collectors.length - 1) return stagedSnapshot(q, country, settled.slice());
    await deepenSilent(q, settled, fetchImpl);
    return finalSnapshot(q, country, settled, fetchImpl);
  });
  const final: Promise<LiveSearchResult> = stages[stages.length - 1] ?? Promise.resolve(stagedSnapshot(q, country, settled));

  // Write-through carries the converged LIVE answer only (products with their
  // scrapedAt stamps included). A converged-empty set is usually a blip inside
  // the bounded window rather than a real answer, so it stays uncached and the
  // next caller re-collects live instead of re-serving the blip.
  void final.then((snap) => {
    if (snap.products.length > 0) cache.write(cacheKey, snap);
  });

  if (cached) {
    // Stale window only reaches here (fresh returns above): cache-first flush,
    // live stages behind it, converged full-ranked final.
    return { stages: [Promise.resolve(cached.value), ...stages], final };
  }
  return { stages, final };
}

/**
 * Collect live results for a query at request time — the blocking view of the
 * staged collection above: every retailer in parallel with bounded per-collector
 * timeouts (a slow or failed retailer only loses its own offers), then the
 * bounded REEA-149 depth round for merchants that stayed silent, then the
 * full-ranked grouping (REEA-167/168) and relaxed-query suggestions. Returns
 * products ranked by title relevance, cheapest first inside each group. Reads
 * only the REEA-277 short-TTL entry of a previous LIVE run — never bundled or
 * hand-written snapshots; every cache entry is itself a fresh fan-out answer.
 *
 * REEA-170 — the optional `country` selection scopes the fan-out to the
 * adapters tagged for that country (still fetched live, per adapter, with the
 * same budgets; unselected retailers are not fetched, staying polite to
 * retailer endpoints), and hits are matched on their adapter's country tag
 * BEFORE grouping so every derived figure — main price rows, availability,
 * best-price flags, retailer counts, cheaper alternatives' fromPrice — comes
 * from the filtered offer set. With no selection the path is unchanged.
 */
export async function collectLiveResults(
  query: string,
  opts: StagedCollectOptions = {},
): Promise<LiveSearchResult> {
  // REEA-224 F4 — enforce the documented LIVE_SEARCH_BUDGET_MS ceiling on the
  // whole chain: the signal is threaded through every fetchChecked hop, so a
  // slow retailer is cut off at the bounded hop window / overall budget
  // instead of leaving the chain waiting on a stalled connection.
  return await collectLiveResultsStaged(query, {
    ...opts,
    signal: opts.signal ?? AbortSignal.timeout(LIVE_SEARCH_BUDGET_MS),
  }).final;
}

/**
 * REEA-149 — canonical query form derived from the answers that DID arrive.
 * Shoppers type model codes ("WH-1000XM6"); some retailers' search engines
 * answer those forms with unrelated filler while the same product is found by
 * its brand+code title ("Sony WH-1000XM6"). The best round-one hit title —
 * a live answer, never seeded data — is exactly that normalized form, so the
 * silent retailers get one more bounded query for the same product instead of
 * dropping out of the comparison entirely.
 */
export function enrichedQuery(hits: SearchHit[], query: string): string {
  let best = "";
  let bestScore = 0;
  for (const h of hits) {
    const score = titleMatchScore(h.title, query);
    if (score > bestScore) {
      bestScore = score;
      best = h.title;
    }
  }
  return best.trim();
}


