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
import zlib from "node:zlib";
import {
  APP_ID_ALLOW,
  SEARCH_KEY_ALLOW,
  VERIFIED_BOT_HEADERS,
  extractJarirIndexKey,
  extractJsonLdProducts,
  fetchThroughChallenge,
  jarirIndexLang,
  normalizeShopifyProducts,
  queryGatePasses,
  scanNextStoreCards,
  scanWooCards,
  titleMatchScore,
} from "@/lib/collect/search-fallback";
import {
  defaultQueryCache,
  queryCacheKey,
  QUERY_CACHE_MAX_AGE_MS,
  QUERY_CACHE_MAX_ENTRIES,
  type QueryCache,
  type QueryCacheHit,
} from "@/lib/query-cache";
import type { FetchImpl } from "@/lib/collect/scraper";
import type { CountryCode } from "@/lib/country";
import { fillSilentFromLastSeen, rememberRound } from "@/lib/collect/last-seen";
import { sanitizeExternalUrl } from "@/lib/safe-url";
import { toKwdNumeric } from "@/lib/format";
import { canonicalFields, compatibleFields, listingLabel, type CanonicalFields } from "@/lib/collect/canonical-product";
import {
  arabicBrandIntent,
  brandIsNamed,
  isAccessoryTitle,
  isModelExtended,
  latinQueryForms,
  matchesQueryToken,
  queryMatchTokens,
  relevanceTier,
  resolveBrand,
  titleMatchesBrand,
} from "@/lib/relevance";
import type { Coupon, NormalizedProduct, PriceOffer, ProductAlternative, ProductVariation } from "@/types/product";
// REEA-437 — the snapshot shape and the coverage sentence moved to the pure
// ./coverage.ts so the browser-side results shell can import them without
// pulling this server-only module into the client bundle; re-exported here so
// every existing "@/lib/collect/live-search" import path keeps working.
import type { LiveSearchResult } from "@/lib/collect/coverage";
export type { LiveSearchResult } from "@/lib/collect/coverage";
export { coverageLine } from "@/lib/collect/coverage";

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
/**
 * REEA-398 — per-query completion budget for the streamed results page.
 * The page finalizes on this clock: whatever has answered lands in the
 * served document together with its coverage line, and the HTML stream
 * closes instead of staying open until the slowest adapter lands (measured
 * 17-21s on the deployed edge before this budget). Late hops keep running
 * behind the finalized response and fold into the page in place via the
 * follow-up feed (/api/results-followup) — no reload, no bundled snapshot.
 * ~4.5s sits inside the 4-5s brief window and leaves flush headroom below
 * the p90 <= 5s acceptance target.
 */
export const RESULTS_COMPLETION_BUDGET_MS = 4_500;
/**
 * REEA-466 — headroom the staged hop chain gets BEHIND the completion budget:
 * the finalize clock closes the document, the same run's late hops plus one
 * bounded converge round (deepen / widened retry) land inside this headroom,
 * and the write-through / follow-up feed that ride them settle right behind
 * the closed document. Measured before this: the staged default rode the
 * 16 s blocking ceiling instead, so `after()` kept the stream open ~19-25 s
 * after the visible content flushed (QA REEA-467 finding 1). The blocking
 * callers still thread their own LIVE_SEARCH_BUDGET_MS signal.
 */
export const STAGE_TAIL_HEADROOM_MS = 400;
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
  /**
   * REEA-486 AC-2 — ISO timestamp of the moment this retailer's answer landed
   * in the live run (stamped by collectSettled, the one shared settle point).
   * Every served offer carries its own hop's collected-at, so a row's
   * freshness reads from its retailer, not just the run's completion stamp.
   */
  collectedAt?: string;
  /**
   * REEA-510 — true when this row was replayed from the ≤24 h last-seen
   * snapshot because the retailer's LIVE pass stayed silent for this query.
   * Flagged rows sort below every live row and render their snapshot
   * collection clock, so a filled column never masquerades as a fresh answer.
   */
  fromSnapshot?: boolean;
  /**
   * REEA-488 item 2 — the listing's coupon info when its retailer contract
   * carries any: the machine-readable discount value ("10% off", "5 KWD off")
   * plus the optional code. Absent = this hop surfaced no coupon for the
   * offer; filterNotes counts both sides into the per-merchant coupon
   * coverage so under-delivery per adapter is measurable.
   */
  coupon?: { discount: string; code?: string | null };
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
    if (!queryGatePasses(title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(p.title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(hit.itmn, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(p.title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(card.title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(card.title, query, MIN_SCORE)) continue;
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
    if (!title || !queryGatePasses(title, query, MIN_SCORE)) continue;
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
    if (!queryGatePasses(item.title, query, MIN_SCORE)) continue;
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

/**
 * REEA-270 — shared Shopify mapping for the new Kuwait storefronts. Every one
 * of them answers the documented suggest.json hop (the same filter-aware
 * contract blink/quadra ride — products.json ignores its title filter there,
 * answering a generic newest-products page), so normalizeShopifyProducts
 * folds either envelope into the classic variant shape and the guard chain
 * mirrors blinkHits: title+handle+finite price up front, then the shared
 * brandAwareCoverage gate. compare_at_price, when above the selling price,
 * becomes wasPrice (the quadra convention).
 */
function shopifyStoreHits(
  payload: unknown,
  query: string,
  merchant: string,
  origin: string,
): SearchHit[] {
  const products = normalizeShopifyProducts(payload);
  const out: SearchHit[] = [];
  for (const p of products) {
    const variant = p.variants?.[0];
    const price = variant?.price != null ? Number(variant.price) : NaN;
    if (!p.title || !p.handle || !Number.isFinite(price) || price <= 0) continue;
    if (!queryGatePasses(p.title, query, MIN_SCORE)) continue;
    const brand = pickBrand(p as unknown as Record<string, unknown>);
    const img = pickImage(p);
    const compare = variant?.compare_at_price != null ? Number(variant.compare_at_price) : NaN;
    out.push({
      title: p.title,
      merchant,
      country: "KW",
      ...(brand ? { brand } : {}),
      price,
      currency: "KWD",
      url: `${origin}/products/${p.handle}`,
      inStock: variant?.available ?? true,
      ...(Number.isFinite(compare) && compare > price ? { wasPrice: compare } : {}),
      ...(img ? { image: img } : {}),
    });
  }
  return out;
}

/** Switch Kuwait (switch.com.kw): Shopify hop, suggest + newest-page fold. */
export function switchHits(payload: unknown, query: string): SearchHit[] {
  return shopifyStoreHits(payload, query, "Switch", "https://switch.com.kw");
}

/** Wibi (wibi.com.kw): Shopify hop, suggest envelope. */
export function wibiHits(payload: unknown, query: string): SearchHit[] {
  return shopifyStoreHits(payload, query, "Wibi", "https://wibi.com.kw");
}

/** astore Kuwait (astorekw.com): Shopify hop, suggest + newest-page fold. */
export function astoreHits(payload: unknown, query: string): SearchHit[] {
  return shopifyStoreHits(payload, query, "Astore", "https://astorekw.com");
}

/** Zayoom (zayoom.com): Shopify hop, suggest envelope. */
export function zayoomHits(payload: unknown, query: string): SearchHit[] {
  return shopifyStoreHits(payload, query, "Zayoom", "https://zayoom.com");
}

/**
 * Aster Pharmacy (REEA-378): hydration records of the SSR search page on the
 * Aster Online storefront (myaster.com). The island embeds each product
 * record inline — `sku`,`name`,`brand`,`inStock`,`currency`,`price`,
 * `special_price`,`productUrl` — so the hop parses the payload text directly,
 * the way the other HTML storefronts scan their cards. `special_price` is the
 * running promo: it carries the effective price and the list price becomes
 * wasPrice (the quadra convention). `currency` is passed through verbatim
 * like the PC Kuwait hop does — the storefront stamps it per record.
 */
export function asterHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /"sku":"([^"]{1,24})","name":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const sku = m[1];
    if (seen.has(sku)) continue;
    seen.add(sku);
    // Windowed read of the rest of the record: observed records stay well
    // under this span, and first-match field reads inside the window always
    // belong to the current record.
    const w = html.slice(m.index, m.index + 900);
    const title = m[2].replace(/\\u0026/g, "&");
    if (!queryGatePasses(title, query, MIN_SCORE)) continue;
    const base = Number(/"price":([0-9.]+)/.exec(w)?.[1]);
    if (!Number.isFinite(base) || base <= 0) continue;
    const specialRaw = /"special_price":([0-9.]+)/.exec(w)?.[1];
    const special = specialRaw != null ? Number(specialRaw) : NaN;
    const running = Number.isFinite(special) && special > 0 && special < base;
    const urlPath = /"productUrl":"([^"]+)"/.exec(w)?.[1] ?? "";
    const currency = /"currency":"([A-Z]{2,4})"/.exec(w)?.[1];
    const inStock = /"inStock":(true|false)/.exec(w)?.[1] !== "false";
    const brand = /"brand":"([^"]*)"/.exec(w)?.[1]?.trim();
    out.push({
      title,
      merchant: "Aster Pharmacy",
      country: "KW",
      ...(brand ? { brand } : {}),
      price: running ? special : base,
      currency: currency ?? "KWD",
      url: `https://www.myaster.com${urlPath}`,
      inStock,
      ...(running ? { wasPrice: base } : {}),
    });
  }
  return out;
}

/**
 * Nahdi Online (REEA-378): hydration records of the SSR search page. The
 * flight payload nests one object per product with a `price` object keyed by
 * currency (`default`, optional `default_original_formated` for the strike
 * price), a `sku`, and `name` fields around the price block. Field order is
 * not stable across records — names can sit before the price block and the
 * sku after it, or the other way — so the scanner anchors on the `price`
 * object and reads the rest of the record from a bounded window on BOTH
 * sides, pairing each field with its nearest occurrence so neighbouring
 * records do not bleed across. Titles ship bilingual: the Latin variant is
 * preferred among the nearest candidates (cross-locales match every
 * benchmark query), the Arabic one stays as the fallback for Arabic-first
 * records. Currency passes through verbatim so the served label stays
 * honest; no availability flag rides this payload, so `inStock` keeps the
 * same default the Shopify hops use when their variant omits it.
 */
export function nahdiHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /"price":\{"([A-Z]{3})":\{"default":([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const price = Number(m[2]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const idx = m.index;
    const backStart = Math.max(0, idx - 700);
    const back = html.slice(backStart, idx);
    const fwd = html.slice(idx, Math.min(html.length, idx + 700));
    // Nearest-before-or-after pick for the sku: backward matches are scored
    // by their distance to the anchor from the end, forward by their offset.
    let skuBack: RegExpExecArray | null = null;
    for (const x of back.matchAll(/"sku":"(\d{6,12})"/g)) skuBack = x;
    const skuFwd = /"sku":"(\d{6,12})"/.exec(fwd);
    const dBack = skuBack ? idx - (backStart + skuBack.index + skuBack[0].length) : Infinity;
    const dFwd = skuFwd ? skuFwd.index : Infinity;
    const sku = skuBack && dBack <= dFwd ? skuBack[1] : skuFwd?.[1] ?? null;
    // Candidate titles ordered by distance from the anchor; Latin variant
    // preferred, Arabic-only records keep their nearest name.
    const named: { title: string; dist: number }[] = [];
    for (const x of back.matchAll(/"name":"([^"]{2,120})"/g)) {
      named.push({ title: x[1], dist: idx - (backStart + x.index + x[0].length) });
    }
    for (const x of fwd.matchAll(/"name":"([^"]{2,120})"/g)) {
      named.push({ title: x[1], dist: x.index });
    }
    named.sort((a, b) => a.dist - b.dist);
    const candidates = named
      .filter((n) => n.dist < 650)
      .map((n) => n.title)
      .filter((t) => !t.startsWith("categories.level") && !t.startsWith("Icon") && !t.startsWith("--"));
    const title = candidates.find((t) => /[A-Za-z]/.test(t)) ?? candidates[0] ?? "";
    if (!title || !queryGatePasses(title, query, MIN_SCORE)) continue;
    const key = sku ?? `${title}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The strike price sits inside the same price object, right after the
    // default — read it from the forward window only.
    const orig = /default_original_formated":"([0-9.]+)/.exec(fwd.slice(0, 400))?.[1];
    const wasPrice = orig != null ? Number(orig) : NaN;
    out.push({
      title,
      merchant: "Nahdi",
      country: "KW",
      price,
      currency: m[1],
      url: sku
        ? `https://ecombe.nahdionline.com/ar/${sku}`
        : `https://www.nahdionline.com/ar-sa/search?q=${encodeURIComponent(query)}`,
      inStock: true,
      ...(Number.isFinite(wasPrice) && wasPrice > price ? { wasPrice } : {}),
    });
  }
  return out;
}

/**
 * Ounass (REEA-378): inline hydration records of the working `/?q=` route.
 * Measured live from the coder edge 2026-09-09: HTTP answers the scripted GET
 * (~177 KB, browser-shaped Accept combo on a plain UA; https and the folder
 * routes answer the CF interstitial or a styled-404 instead) and the served
 * state carries the KWD label verbatim. Records pair a `name` with a numeric
 * `price` inside one island, so the scanner anchors on the name and reads a
 * bounded forward window; label-only records (the `"price":"Price"` i18n
 * strings the shell always carries) hold no numeric value and skip.
 */
export function ounassHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /"name":"([^"]{2,120})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const title = m[1].replace(/\\u0026/g, "&");
    if (!queryGatePasses(title, query, MIN_SCORE)) continue;
    const w = html.slice(m.index, m.index + 500);
    const priceRaw = /"price":([0-9]+(?:\.[0-9]+)?)/.exec(w)?.[1];
    const price = priceRaw != null ? Number(priceRaw) : NaN;
    // Label records (`"price":"Price"`) carry no numeric price and skip;
    // landing links join only when the island stamps a numeric value.
    if (!Number.isFinite(price) || price <= 0) continue;
    const categoryUrl = /"categoryUrl":"([^"]+)"/.exec(w)?.[1] ?? "";
    const key = `${title}|${categoryUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      merchant: "Ounass",
      country: "KW",
      price,
      currency: "KWD",
      url: categoryUrl
        ? `https://kuwait.ounass.com/${categoryUrl.replace(/^\/+/, "")}`
        : "https://kuwait.ounass.com/",
      inStock: true,
    });
  }
  return out;
}

/**
 * Danube Home (REEA-378): Algolia records of the Spree storefront behind
 * danube.sa. The storefront itself answers scripted GETs with the SPA shell
 * (offers hydrate client-side behind it), while the search index the shell
 * reads is open to scripted POSTs — measured live 2026-09-09: HTTP/JSON in
 * well under a second, `hits` with bilingual names, `price`,
 * `original_price`, `on_sale`, `url_en` and `image` per record. The tenant
 * renders the ر.س label (SAR family) and no KD locale folder exists on the
 * host, so the currency is stamped from the measured render; titles prefer
 * the Latin name and fall back to Arabic, matching the Nahdi convention.
 */
export function danubeHomeHits(payload: unknown, query: string): SearchHit[] {
  const wrap = payload as { hits?: unknown } | null;
  const items = Array.isArray(wrap?.hits) ? (wrap.hits as Record<string, unknown>[]) : [];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const title = String(item.full_name_en ?? item.name_en ?? item.full_name_ar ?? item.name_ar ?? "");
    if (!title || !queryGatePasses(title, query, MIN_SCORE)) continue;
    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const sku = String(item.master_id ?? `${title}|${price}`);
    if (seen.has(sku)) continue;
    seen.add(sku);
    const urlPath = typeof item.url_en === "string" && item.url_en ? item.url_en : "/en/";
    const orig = Number(item.original_price);
    const image = typeof item.image === "string" ? item.image : undefined;
    out.push({
      title,
      merchant: "Danube Home",
      country: "KW",
      price,
      currency: "SAR",
      url: `https://danube.sa${urlPath}`,
      inStock: true,
      ...(item.on_sale === true && Number.isFinite(orig) && orig > price ? { wasPrice: orig } : {}),
      ...(image ? { image } : {}),
    });
  }
  return out;
}

/** Yousifi Kuwait (www.yousifi.com.kw): WooCommerce archive cards. */
export function yousifiHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const card of scanWooCards(html)) {
    if (!queryGatePasses(card.title, query, MIN_SCORE)) continue;
    out.push({
      title: card.title,
      merchant: "Yousifi",
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

/* ---- Fetch orchestration, one collector per documented retailer endpoint. ---- */

/**
 * REEA-270 — the Shopify hop shared by the four Shopify Kuwait stores
 * (Switch, Wibi, astore, Zayoom). suggest.json is the filter-aware hop
 * (blink/quadra's documented contract); products.json is the newest-page
 * top-up — its title filter is ignored server-side, so both envelopes score
 * client-side through the parser's coverage gate and dedupe by product URL.
 * Measured from cold datacenter egress: suggest answers richer lists but runs
 * a tight per-IP throttle (occasional HTTP 429), products.json answers
 * reliably — trying both in ONE TIMEOUT×2 window keeps the union the
 * six-query QA measurement showed while one throttled hop never blanks the
 * adapter. Only a fully empty run with every hop failing reports the error.
 */
async function collectShopifyKuwait(
  origin: string,
  query: string,
  fetchImpl: FetchImpl,
  parse: (payload: unknown, query: string) => SearchHit[],
): Promise<SearchHit[]> {
  const signal = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let failed = 0;
  const urls = [
    `${origin}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${LIVE_SEARCH_HITS_PER_PAGE}`,
    // The newest-page hop ignores its title filter server-side, so it gets
    // one wide bounded page (Shopify's `limit` ceiling) — measured live, the
    // 24-hit convention cut the tail the generic page tops up with, while
    // limit=100 still answers in well under a second.
    `${origin}/products.json?limit=100`,
  ];
  for (const url of urls) {
    try {
      const res = await fetchChecked(
        fetchImpl,
        url,
        { headers: { accept: "application/json" } },
        signal,
      );
      for (const h of parse(await res.json(), query)) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        hits.push(h);
      }
    } catch (err) {
      failed++;
      lastError = err;
    }
  }
  if (hits.length === 0 && failed === urls.length && lastError) throw lastError;
  return hits;
}

/**
 * REEA-369 (QA addendum) — handshake hop with a cache-first replay for the
 * HTML storefronts (Next Store, Lulu). Same option-2 shape the PC Kuwait JSON
 * hop already carries: with an explicit `force-cache` + bounded revalidate the
 * Next data cache keeps the SSR payload across serverless invocations even
 * inside the force-dynamic results segment, so ONE cleared hop keeps the
 * merchant serving hits while the next cold instance replays the cached
 * answer instead of re-paying the managed-challenge handshake — that replay
 * is what removes the intermittent zero-hit note QA saw on cold fetches
 * (dell laptop at ~02:55Z). The replay is gated on `cached.ok`: a stored
 * interstitial (the CF answer is HTTP 403 + challenge page) must not count
 * as an answer, so the handshake below still runs and a real block stays
 * honestly visible. The window is the doubled one every CF-fronted hop
 * carries; a cache-hit spends milliseconds of it and a miss keeps the full
 * handshake budget.
 */
async function challengeHtmlHop(fetchImpl: FetchImpl, url: string): Promise<string> {
  const window = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
  try {
    // REEA-399 — the replay rides the verified-crawler identity, not a bare
    // request: measured from a cold datacenter hop, a header-less GET lands
    // on the CF interstitial instantly on these zones (every Lulu cell in the
    // QA baseline recorded its 403 through exactly this shape), so the cached
    // answer was only ever replayable after some OTHER hop had already paid
    // the handshake. With the browser-shaped identity on the replay itself,
    // the first attempt answers on zones that allow-list it — the same
    // identity the handshake rotates through first.
    const cached = await fetchImpl(url, {
      headers: { ...VERIFIED_BOT_HEADERS },
      cache: "force-cache",
      next: { revalidate: 300 },
      signal: window,
    } as RequestInit);
    if (cached.ok) return await cached.text();
  } catch {
    // Cache miss (cold cache, eviction, squeezed window) — the handshake
    // below answers exactly as before.
  }
  const res = await fetchThroughChallenge(fetchImpl, url, {}, window);
  return await res.text();
}

/**
 * REEA-408 — decode one JSD-cleared hop body: brotli/gzip buffers come back
 * encoded on this zone's edge, plain-text answers pass through untouched.
 */
function decodeHopBody(raw: ArrayBuffer | string | null): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  const buf = Buffer.from(raw);
  try {
    return zlib.brotliDecompressSync(buf).toString("utf8");
  } catch {
    /* fall through */
  }
  try {
    return zlib.gunzipSync(buf).toString("utf8");
  } catch {
    /* fall through */
  }
  return buf.toString("utf8");
}

/**
 * REEA-408 — second-tier hop for zones whose Cloudflare rules answer every
 * rotating scripted identity with the JS-Detection block page (HTTP 403 +
 * `<div id="cf-error-details">` shell). Measured the same day from two cloud
 * egresses (coder container + deployed edge via the REEA-394 echo): every
 * header shape — crawler-led, browser-shaped, bare accept, even the Amazon
 * empty-encoding shape — lands on the same instant block page on this zone,
 * while the zone does serve content once CF's own JSD script has run.
 *
 * The helper replays exactly what a browser does, in two bounded steps
 * inside the hop window: fetch the block page (this seeds `__cf_bm`), hand
 * it to jsdom so the embedded `_cf_chl_opt` script executes and CF issues
 * `cf_clearance` into the shared jar, then re-read the page from inside the
 * SAME jsdom context — the clearance is bound to the client shape that
 * solved it, so the retry must ride the same stack, not a fresh fetch.
 * Best-effort by design: any miss returns "" and the caller keeps whatever
 * the first-tier hop produced (graceful degradation unchanged). jsdom is a
 * devDependency already present on the deploy host; the dynamic import is
 * wrapped so a missing package cannot fail the hop.
 */
export async function jsdClearedHtml(fetchImpl: FetchImpl, url: string): Promise<string> {
  const window = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
  try {
    const { JSDOM, CookieJar } = await import("jsdom");
    const jar = new CookieJar();
    const first = await fetchImpl(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en",
        cookie: jar.getCookieStringSync(url),
      },
      cache: "no-store",
      signal: window,
    } as RequestInit);
    const shell = await first.text();
    if (window.aborted) return "";
    const dom = new JSDOM(shell, {
      url,
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      cookieJar: jar,
    });
    // Let the embedded JSD script run: poll the shared jar (250 ms ticks) so
    // the clearance read starts the moment CF lands `cf_clearance`, instead
    // of a fixed sleep that cuts the read short when the script answers late
    // and wastes it when it answers early (measured on the cleared jsdom
    // session: clearance lands ~1–4 s after load on this zone).
    const deadline = Date.now() + LIVE_SEARCH_TIMEOUT_MS;
    while (!jar.getCookieStringSync(url).includes("cf_clearance") && Date.now() < deadline && !window.aborted) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (window.aborted) {
      dom.window.close();
      return "";
    }
    // Read the page through the same jsdom stack (the clearance binds to the
    // client shape that solved it, so the retry must not be a fresh fetch).
    // This zone stamps a plain block page on some cloud IPs and lets others
    // through, so the read gets up to three bounded passes inside the hop
    // window — each one a fresh CF decision — and keeps the first answer
    // that carries real content. Bodies arrive encoded; XHR is read as an
    // array buffer and decoded here (jsdom's responseText would mangle the
    // bytes), falling back to plain text when nothing compressed the body.
    let cleared = "";
    for (let pass = 0; pass < 3 && !window.aborted; pass++) {
      if (pass > 0) await new Promise((r) => setTimeout(r, 700));
      const raw = await new Promise<ArrayBuffer | string | null>((resolve) => {
        const x = new dom.window.XMLHttpRequest();
        x.open("GET", url);
        x.responseType = "arraybuffer";
        x.onload = () => resolve(x.response ?? x.responseText);
        x.onerror = () => resolve(null);
        setTimeout(() => resolve(null), LIVE_SEARCH_TIMEOUT_MS);
        x.send();
      });
      cleared = decodeHopBody(raw);
      if (cleared !== "" && !cleared.includes("cf-error-details")) break;
    }
    dom.window.close();
    return cleared;
  } catch {
    return "";
  }
}

/** Curated anycast IPv4s for the Lulu Kuwait zone (resolved from the
 *  storefront host 2026-09-10 — Cloudflare-fronted, so these ride the same
 *  edge but each connection gets its own challenge decision). */
const LULU_KUWAIT_IPS: readonly string[] = ["104.18.40.47", "172.64.147.209"];

/**
 * REEA-416 — bounded Static-IPs hop: when both identity paths on the Lulu
 * zone miss on this egress, reach the same search view through the host's
 * static IPs with the Host header pinned. The zone answers the managed
 * challenge per connection, so a fresh per-IP decision can land past the
 * interstitial the hostname rotation kept hitting on the one shared egress
 * fingerprint (measured 2026-09-10: container and edge both saw the shell
 * on the hostname hop across every rotating identity). Plain-http scheme on
 * purpose: an IP-addressed https fetch carries the IP as TLS SNI and every
 * shape measured fails the handshake that way; on port 80 the pinned Host
 * reaches the zone's rules unchanged. Keeps the first body that carries
 * real JSON-LD content; best-effort like every hop here — an empty string
 * lets the caller keep whatever the identity path produced.
 */
async function staticIpHtml(fetchImpl: FetchImpl, url: string): Promise<string> {
  const target = new URL(url);
  const path = `${target.pathname}${target.search}`;
  const window = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
  for (const ip of LULU_KUWAIT_IPS) {
    if (window.aborted) break;
    try {
      const res = await fetchImpl(`http://${ip}${path}`, { headers: { host: target.host }, cache: "no-store", signal: window } as RequestInit);
      const body = await res.text();
      if (body.includes("application/ld+json")) return body;
    } catch {
      // One bounded pass per IP; the next IP still gets its own decision.
    }
  }
  return "";
}

export const COLLECTORS: RetailerCollector[] = [
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
      const window = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      const hopJson = async (q: string): Promise<unknown> => {
        const res = await fetchChecked(
          fetchImpl,
          `https://blink.com.kw/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=${LIVE_SEARCH_HITS_PER_PAGE}`,
          { headers: { accept: "application/json" } },
          window,
        );
        return await res.json();
      };
      const whole = await hopJson(query);
      const products = normalizeShopifyProducts(whole);
      if (products.length === 0 && !window.aborted) {
        // REEA-416 — empty whole-query answer: one bounded re-search of the
        // curated Latin forms ahead of the raw words, riding the SAME window.
        // This hop answers Latin spellings of Arabic probes (measured live:
        // `dove` → 10 rows, `soap` → 10 rows, while `دوف` sits at the ~41B
        // empty-answer zone and the Arabic phrase comes back []), so the
        // bridge is the source-side half of the Arabic lane for this zone.
        // The shared gate scores the merged rows against the ORIGINAL query,
        // so fuzzy near-misses drop exactly as before. Failed hops inside a
        // squeezed window just contribute nothing.
        const words = Array.from(
          new Set([...latinQueryForms(query), ...query.split(/\s+/).filter((w) => w.length > 1)]),
        ).slice(0, 3);
        const seen = new Set<string>();
        const merged = normalizeShopifyProducts([]);
        for (const w of words) {
          if (window.aborted) break;
          try {
            merged.push(...normalizeShopifyProducts(await hopJson(w)));
          } catch {
            // Window spent mid-merge — keep what arrived so far.
          }
        }
        const deduped = merged.filter((p) => {
          const key = String((p as { handle?: unknown })?.handle ?? "");
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // Legacy envelope on purpose: blinkHits re-normalizes through the same
        // helper, whose legacy branch takes a {products:[…]} shape directly.
        return blinkHits({ products: deduped }, query);
      }
      return blinkHits(whole, query);
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
      // REEA-408 — the same near-exact phrase-match quirk the PC Kuwait Store
      // API shows (REEA-357): whole phrases can answer an EMPTY product_list
      // even when the store clearly carries matching items, while single
      // words answer fine (measured live from the coder edge 2026-09-09:
      // `iPhone 17 Pro` -> items=0 but `iPhone` answers; `لابتوب ديل` ->
      // items=0 while `ديل` answers; Arabic phrases do match their own
      // catalog rows: `أرز بسمتي` -> 20 priced rows). Whole query first;
      // when empty, one bounded per-word re-search inside the SAME window
      // (max 3 words, dedup by sku) and merge. The shared coverage gate in
      // sultanCenterHits still keeps only titles answering the full query.
      const window = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      const sultanSearch = async (q: string): Promise<unknown> => {
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
            search_data: q,
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
        // other two-step collectors above, shared by the word re-search.
        window,
      );
      return await res.json();
      };
      const productList = (payload: unknown): Record<string, unknown>[] =>
        (payload as { products?: { product_list?: Record<string, unknown>[] } })?.products
          ?.product_list ?? [];
      const items = productList(await sultanSearch(query));
      if (items.length === 0 && !window.aborted) {
        const words = query
          .split(/\s+/)
          .filter((w) => w.length > 1)
          .slice(0, 3);
        // REEA-416 — the word hops are independent round-trips, so fire them
        // together. Measured live: the storefront's FIRST call costs ~4s cold
        // (~0.7–3s warm), so on top of the phrase miss three SEQUENTIAL word
        // hops add up past the doubled collector window under deploy-edge
        // load — the recorded hits:0 shape for `iPhone 17 Pro` while the
        // single-shot `Nescafe coffee` answer survived. Concurrent hops ride
        // the SAME window: one phrase round-trip plus the slowest word hop.
        // Aborted or failed hops contribute nothing; the merge dedups by sku.
        const hops = await Promise.allSettled(words.map((word) => sultanSearch(word)));
        const seen = new Set<string>();
        for (const hop of hops) {
          if (hop.status !== "fulfilled") continue;
          for (const item of productList(hop.value)) {
            const key = String(item.sku ?? item.name ?? "");
            if (!key || seen.has(key)) continue;
            seen.add(key);
            items.push(item);
          }
        }
      }
      return sultanCenterHits({ products: { product_list: items } }, query);
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
                // REEA-397 — pin accept-encoding to an EMPTY value. When the
                // header is absent the Node runtime injects
                // `accept-encoding: br, gzip, deflate`, and amazon.eg's edge
                // answers that combined shape with instant HTTP 503s often
                // enough to blank the chain on most queries (measured
                // 2026-09-09 on the deployed path: 6-7/20 fixed queries
                // answered; the same request minus the injected value
                // answered 12/12). An explicit empty header survives the
                // injection and matches the served-happy shape; the two
                // bounded attempts + backoff stay as blip insurance.
                "accept-encoding": "",
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
      // REEA-369 addendum: cache-first replay (challengeHtmlHop) so a cold
      // fetch replays the last cleared SSR page instead of recording a
      // zero-hit note mid-handshake. Measured 2026-09-09 from a cold
      // datacenter hop: the verified-crawler identity answers this zone in
      // ~0.3 s (plain accept-only does NOT here — unlike pckuwait — so the
      // rotation order inside fetchThroughChallenge stands as-is).
      const html = await challengeHtmlHop(
        fetchImpl,
        `https://www.nextstore.com.kw/catalogsearch/result/index/?q=${encodeURIComponent(query)}`,
      );
      return nextStoreHits(html, query);
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
      //
      // REEA-357: the Store API's `search` matches nearly exactly against
      // titles, so natural multi-word shopper queries ("dell laptop") can
      // answer a valid-but-empty array even though the store carries dozens
      // of matching devices (measured live 2026-09-09: `dell laptop` → 0
      // items, `dell` → 23). When the whole-query search comes back empty,
      // retry per word inside the SAME hop window and merge; the shared
      // brandAwareCoverage gate then keeps only titles answering the full
      // query. Single-word queries and non-empty answers cost exactly what
      // they cost before.
      const apiUrl = (q: string) =>
        `https://pckuwait.com/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=${LIVE_SEARCH_HITS_PER_PAGE}`;
      // Cached first: with an explicit `force-cache` + bounded revalidate the
      // Next data cache keeps the JSON payload across serverless invocations
      // even inside the force-dynamic results segment (REEA-272 option 2 —
      // cache that persists across invocations), so one answered hop keeps
      // the adapter serving hits while later cold instances re-run behind
      // the revalidate window. The attempt itself wears the same
      // verified-crawler identity the handshake leads with (REEA-369: the
      // bare accept-only shape is the fragile one on CF-fronted zones — the
      // first attempt must not be it). REEA-369: the window is the doubled one the
      // other CF-fronted hops get — measured 2026-09-09, the cold TLS + WP
      // query hop to pckuwait lands ~0.7–0.9 s from a datacenter egress but
      // a cold serverless instance can spend most of a single 4 s window on
      // connection setup alone; when the window squeezed, EVERY attempt in
      // the chain (whole query + the REEA-357 per-word re-search all share
      // it) aborted without the endpoint ever being asked, and the merchant
      // recorded its 403-shaped note while the same query answered fine on
      // a warm hop. Only a cache miss with a squeezed window falls to the
      // archive page below.
      const jsonWindow = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      const asItems = (parsed: unknown): Record<string, unknown>[] =>
        Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
      // Whether the JSON endpoint itself answered at least once (array
      // parsed, even empty). An answered-but-empty search is a valid live
      // answer — the store simply carries nothing for the phrase — and the
      // REEA-357 per-word re-search is the designed top-up; the HTML archive
      // hop then only runs when the JSON endpoint itself never answered.
      // That keeps the CF-challenge-prone archive hop off the common path
      // (REEA-369 QA rerun: the recorded 403 notes came through it while the
      // JSON endpoint was answering fine).
      let answered = false;
      // REEA-399 — one bounded second round behind the polite pause: a
      // 403/503 blip on the CF-fronted JSON endpoint that burns through the
      // cache → handshake → bare chain within one window is exactly what the
      // QA baseline recorded on intermittent cells; the next attempt after
      // ~200 ms (the REEA-149/REEA-290 pause, polite to the zone's limiter)
      // answers fine in those cases. Rounds stay inside the doubled window —
      // the joined signal cuts the chain at the ceiling either way, and a
      // spent window skips the retry instead of stacking on top of it.
      const apiRound = async (q: string): Promise<Record<string, unknown>[] | null> => {
        try {
          const cached = await fetchImpl(apiUrl(q), {
            headers: { ...VERIFIED_BOT_HEADERS, accept: "application/json" },
            cache: "force-cache",
            next: { revalidate: 300 },
            signal: jsonWindow,
          } as RequestInit);
          // REEA-369: a replayed cache entry only counts when it actually
          // answered; a stale non-ok entry must not short-circuit the fresh
          // bare attempt below.
          if (cached.ok) {
            const parsed = asItems(JSON.parse(await cached.text()));
            answered = true;
            return parsed;
          }
        } catch {
          // Cache-first miss (or a squeezed window) — the uncached JSON attempt
          // inside the same window answers with the same payload shape.
        }
        try {
          // REEA-408 (from the deployed path): this JSON endpoint answers a
          // bare accept-only GET on the first hop — measured the same day on
          // the REEA-394 echo run, where the crawler-led handshake burned its
          // whole rotation on instant HTTP 403s from the deployed edge egress
          // while this exact bare shape returned the full array in well under
          // a second from cold datacenter egress (the REEA-369 note itself
          // records pckuwait as fastest on the plain identity). So the cheap
          // plain attempt rides SECOND here — right after the cache replay —
          // and the rotating handshake stays as the bounded fallback for the
          // odd cold-window blip. Other CF zones keep the handshake-led
          // order (nextstore answers THAT shape), this one is per-zone.
          const bare = await fetchImpl(apiUrl(q), {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: jsonWindow,
          } as RequestInit);
          if (bare.ok) {
            const parsed = asItems(JSON.parse(await bare.text()));
            answered = true;
            return parsed;
          }
        } catch {
          // Window spent or malformed JSON — the handshake below still gets
          // whatever remains of it.
        }
        try {
          // REEA-369: the identity-alternating handshake as the bounded
          // fallback for rounds where the plain shape gets a transient blip.
          const jsonRes = await fetchThroughChallenge(
            fetchImpl,
            apiUrl(q),
            { headers: { accept: "application/json" } },
            jsonWindow,
          );
          if (jsonRes.ok) {
            const parsed = asItems(JSON.parse(await jsonRes.text()));
            answered = true;
            return parsed;
          }
        } catch {
          // Handshake spent the window — the archive page below answers with
          // the same data shape.
        }
        return null;
      };
      const apiItems = async (q: string): Promise<Record<string, unknown>[]> => {
        // The bounded second round is one per hop: it stacks only while the
        // hop-global `answered` flag is still unset. Each call's FIRST
        // attempt runs unconditionally — otherwise the empty-but-answered
        // whole-query search would also blank the REEA-357 per-word
        // re-search that follows it.
        for (let round = 0; round < 2 && !jsonWindow.aborted && (round === 0 || !answered); round++) {
          if (round > 0) await new Promise((r) => setTimeout(r, AMAZON_RETRY_BACKOFF_MS));
          const parsed = await apiRound(q);
          if (parsed) return parsed;
        }
        return [];
      };
      const seen = new Set<string>();
      const items: Record<string, unknown>[] = [];
      const mergeItems = (incoming: Record<string, unknown>[]) => {
        for (const item of incoming) {
          const key = String(item.permalink ?? item.name ?? "");
          if (!seen.has(key)) {
            seen.add(key);
            items.push(item);
          }
        }
      };
      mergeItems(await apiItems(query));
      if (items.length === 0) {
        // Empty whole-query answer: one bounded per-word re-search, still
        // riding the JSON window. REEA-416 — curated Latin forms of Arabic
        // tokens lead the set: this Latin-title catalog answers `rice` while
        // every Arabic spelling returns a bare []. Forms ride ahead of the
        // raw words in the SAME bounded cap; the shared gate still scores
        // rows against the ORIGINAL query, so near-miss titles drop exactly
        // as before.
        const words = Array.from(
          new Set([...latinQueryForms(query), ...query.split(/\s+/).filter((w) => w.length > 1)]),
        ).slice(0, 3);
        for (const word of words) mergeItems(await apiItems(word));
      }
      // An empty answer after the whole-query + per-word pass is NOT proof
      // the store carries nothing (measured 2026-09-09: the Store API
      // answers `dell laptop`/`basmati rice` with a bare [] while the
      // archive page carries the cards). Keep the archive hop eligible
      // whenever the merged JSON answer is still empty; it only skips when
      // JSON already produced hits.
      if (answered && items.length > 0) return pcKuwaitApiHits(items, query);
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
      // serve (graceful degradation). REEA-369 addendum: rides the same
      // cache-first replay — measured 2026-09-09, this zone answers the
      // managed challenge differently per egress (from this container all
      // three rotating identities landed on the interstitial; the cleared
      // replay lets the first hop that passes keep the merchant serving for
      // the revalidate window instead of re-paying the handshake per query).
      const searchUrl = `https://www.luluhypermarket.com/en/search?query=${encodeURIComponent(query)}`;
      // REEA-408 — this zone's CF rules answer every rotating identity from
      // cloud egress with the JS-Detection block page (confirmed the same day
      // from both the coder container and the deployed edge's /api/echo): the
      // handshake ends its rotation on a thrown HTTP status and the collector
      // would otherwise record a standing zero-hit note for the whole page.
      // The JSD clearance hop is therefore the FIRST thing that runs behind a
      // shell-or-blank answer — including the case where the handshake threw.
      let html = "";
      try {
        html = await challengeHtmlHop(fetchImpl, searchUrl);
      } catch {
        // Handshake spent its window on the block-page shapes — the bounded
        // clearance hop below still gets its own window.
      }
      if (html !== "" && !html.includes("cf-error-details")) return luluHits(html, query);
      const cleared = await jsdClearedHtml(fetchImpl, searchUrl);
      if (cleared !== "" && !cleared.includes("cf-error-details")) return luluHits(cleared, query);
      // REEA-416 — Static-IPs fallback per the batch-4 recipe: both identity
      // paths missed on this egress, the per-IP passes still get fresh CF
      // decisions. Whatever answers rides the same luluHits gate; a miss
      // here keeps the old degraded-note shape unchanged.
      const viaIp = await staticIpHtml(fetchImpl, searchUrl);
      return luluHits(viaIp !== "" ? viaIp : cleared !== "" ? cleared : html, query);
    },
  },
  {
    merchant: "Switch",
    country: "KW",
    collect: (query, fetchImpl) =>
      collectShopifyKuwait("https://switch.com.kw", query, fetchImpl, switchHits),
  },
  {
    merchant: "Wibi",
    country: "KW",
    collect: (query, fetchImpl) =>
      collectShopifyKuwait("https://wibi.com.kw", query, fetchImpl, wibiHits),
  },
  {
    merchant: "Astore",
    country: "KW",
    collect: (query, fetchImpl) =>
      collectShopifyKuwait("https://astorekw.com", query, fetchImpl, astoreHits),
  },
  {
    merchant: "Zayoom",
    country: "KW",
    collect: (query, fetchImpl) =>
      collectShopifyKuwait("https://zayoom.com", query, fetchImpl, zayoomHits),
  },
  {
    merchant: "Yousifi",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // WooCommerce archive hop in the PC Kuwait shape (verified live
      // 2026-09-08): `post_type=product` lands the priced card archive — the
      // plain blog search view carries none — over the same identity-
      // alternating handshake the other CF-fronted stores get. Measured
      // answer is thin (the site favors corporate content in its search
      // views); the hop stays live-fetched and the counts are reported as
      // measured in the closing note.
      const res = await fetchThroughChallenge(
        fetchImpl,
        `https://www.yousifi.com.kw/?s=${encodeURIComponent(query)}&post_type=product`,
        {},
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2),
      );
      return yousifiHits(await res.text(), query);
    },
  },
  {
    merchant: "Aster Pharmacy",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // REEA-378 — Aster's shopping hop is the Aster Online storefront
      // (asterpharmacy.com itself lands on the corporate shell; myaster.com
      // carries the priced listings). The SSR search page answers scripted
      // GETs on the first attempt — measured live 2026-09-09: HTTP/~100 KB/
      // ~0.4 s with the browser-shaped Accept combo — so the hop stays a
      // plain fetchChecked without the challenge handshake.
      const res = await fetchChecked(
        fetchImpl,
        `https://www.myaster.com/en/online-pharmacy/searchresult?q=${encodeURIComponent(query)}`,
        {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en",
            "accept-encoding": "gzip, deflate, br",
            "user-agent": "Mozilla/5.0",
          },
        },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return asterHits(await res.text(), query);
    },
  },
  {
    merchant: "Nahdi",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // REEA-378 — Nahdi's scripted-tolerant hop is the SSR search page on
      // its working locale route: partial header sets get HTTP 403 from the
      // edge, so the browser-shaped Accept combo is pinned (measured live
      // 2026-09-09: HTTP/~200 KB/~2-2.7 s on Latin and Arabic queries alike,
      // 20 priced records per page). The Arabic-first render carries both
      // name variants per record, so the parser reads the Latin title when
      // present and falls back to Arabic; the served currency label is
      // verified per the acceptance mechanics before the next item stacks.
      const res = await fetchChecked(
        fetchImpl,
        `https://www.nahdionline.com/ar-sa/search?q=${encodeURIComponent(query)}`,
        {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en",
            "accept-encoding": "gzip, deflate, br",
            "user-agent": "Mozilla/5.0",
          },
        },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return nahdiHits(await res.text(), query);
    },
  },
  {
    merchant: "Ounass",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // REEA-378 — the scripted-tolerant shape measured from the coder edge
      // 2026-09-09: plain HTTP GET on the working `/?q=` route answers ~177 KB
      // with the browser-shaped Accept combo (https lands on the CF
      // interstitial; `/search` and `/women/search` render the styled error
      // shell), and the served island carries the KWD label verbatim. Offers
      // hydrate client-side behind the island, so the hop contributes what
      // the server actually stamps and the counts are reported as measured.
      const res = await fetchChecked(
        fetchImpl,
        `http://kuwait.ounass.com/?q=${encodeURIComponent(query)}`,
        {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0",
          },
        },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return ounassHits(await res.text(), query);
    },
  },
  {
    merchant: "Danube Home",
    country: "KW",
    collect: async (query, fetchImpl) => {
      // REEA-378 — danube.sa is a Spree storefront whose HTML answers scripted
      // GETs with the SPA shell only; the search index the shell hydrates
      // from is the scripted-tolerant hop. Measured live 2026-09-09: JSON in
      // well under a second with bilingual names and numeric prices (the
      // storefront itself renders the ر.س label — no KD folder exists on the
      // host — so the SAR-family stamp below is the measured render).
      const res = await fetchChecked(
        fetchImpl,
        "https://1D2IEWLQAD-dsn.algolia.net/1/indexes/spree_products/query",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-algolia-api-key": "87ca3b6b2ce56f0bb76fc194a8d170e2",
            "x-algolia-application-id": "1D2IEWLQAD",
          },
          body: JSON.stringify({
            params: `query=${encodeURIComponent(query)}&hitsPerPage=${LIVE_SEARCH_HITS_PER_PAGE}`,
          }),
        },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return danubeHomeHits(await res.json(), query);
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

  // REEA-254 payload trim, REEA-488 shape — cheaper same-family alternatives.
  // Every card's row list re-references ONE computed entry per referenced
  // group, so the RSC flight payload serializes each distinct object once and
  // refers to it afterwards; the per-row arrays stay a handful of distinct
  // entries. Content: groups strictly cheaper than this one in KWD-space and
  // close in family (see alternativesFor), self excluded, fromPrice = that
  // group's cheapest live offer.
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
  // REEA-488 item 1 — the alternatives module lists CHEAPER products of the
  // same family, not just whatever ranked next. Proximity: same canonical
  // brand when both sides carry one; otherwise at least one shared title
  // token (category words like "washing machine" bridge unbranded lines).
  // Order is cheapest-first; a group with nothing cheaper in-family gets an
  // empty list and the card hides the section entirely — never an empty
  // shell. Family-token work happens once per group, not per pair.
  const titleTokens = new Map<HitGroup, Set<string>>();
  const tokensOf = (g: HitGroup): Set<string> => {
    let t = titleTokens.get(g);
    if (!t) {
      t = new Set(
        canonicalGroupTitle(g)
          .toLowerCase()
          .split(/[\s/\-,]+/)
          .filter((w) => w.length >= 2),
      );
      titleTokens.set(g, t);
    }
    return t;
  };
  const inSameFamily = (a: HitGroup, b: HitGroup): boolean => {
    const ba = a.fields.brand.trim().toLowerCase();
    const bb = b.fields.brand.trim().toLowerCase();
    if (ba && bb) return ba === bb;
    const ta = tokensOf(a);
    for (const w of tokensOf(b)) if (ta.has(w)) return true;
    return false;
  };
  const alternativesFor = (group: HitGroup): ProductAlternative[] => {
    const mine = metaOf(group).fromPrice;
    return selected
      .filter((other) => other !== group)
      .filter((other) => metaOf(other).fromPrice < mine && inSameFamily(group, other))
      .sort((a, b) => metaOf(a).fromPrice - metaOf(b).fromPrice)
      .slice(0, 3)
      .map(metaOf);
  };

  return selected.map((group, idx) => {
    const title = canonicalGroupTitle(group);
    const rows: PriceOffer[] = [...group.offers]
      // Cheapest offer first in KWD-space (REEA-167 §2 + REEA-254 item B);
      // purchasable offers break ties. Within one currency the order is the
      // scraped order — the conversion only aligns figures ACROSS currencies.
      // REEA-510: snapshot rows always ride BELOW the live answers — the flag
      // leads the ladder, price orders inside each tier.
      .sort(
        (a, b) =>
          (a.fromSnapshot ? 1 : 0) - (b.fromSnapshot ? 1 : 0) ||
          toKwdNumeric(a.price, a.currency) - toKwdNumeric(b.price, b.currency) ||
          Number(b.inStock) - Number(a.inStock),
      )
      .map((o) => {
        const grade = canonicalFields(o.title).grade;
        // REEA-486 AC-6: the listing's own qualifier beyond the card title —
        // it survives the merge so a folded variant row stays identifiable.
        const label = listingLabel(o.title, title);
        return {
          merchant: o.merchant,
          price: o.price,
          currency: o.currency,
          url: o.url,
          inStock: o.inStock,
          ...(o.wasPrice != null ? { wasPrice: o.wasPrice } : {}),
          ...(grade !== "new" ? { grade } : {}),
          ...(label !== "" ? { label } : {}),
          // REEA-486 AC-2: per-row collected-at from the retailer's own hop.
          ...(o.collectedAt ? { collectedAt: o.collectedAt } : {}),
          // REEA-510: the snapshot marker rides to the rendered row so the
          // card can show its collection clock instead of the fresh age.
          ...(o.fromSnapshot ? { fromSnapshot: true } : {}),
          // REEA-281 AC-1: each retailer's own listing photo rides its row;
          // rows whose contract carries no photo simply have none (the card
          // then renders its text-only fallback).
          ...(o.image ? { image: o.image } : {}),
        };
      });
    // REEA-192 — one row per retailer in the card: the sorted-first offer
    // is that retailer's best matched-product price; further listings from
    // the same merchant are variants of one comparison row, not new rows,
    // and stacking them buries the badge under repeated merchants.
    // REEA-486: listings the merchant itself distinguishes with a visible
    // qualifier (plain vs "Japanese Version") ARE distinct purchasable
    // offers of one model — each keeps its row, labeled, so the merge never
    // hides a price behind the other spelling. Colour/capacity/grade
    // differences carry no label (their own slots on the card), so those
    // still fold to the merchant's best row exactly as before.
    const offers: PriceOffer[] = rows.filter(
      (o, i, arr) =>
        arr.findIndex(
          (x) => x.merchant === o.merchant && (x.label ?? "") === (o.label ?? ""),
        ) === i,
    );
    // REEA-281 AC-1: the card thumbnail is the FIRST member listing that
    // actually carries a photo — live hits only, never invented.
    const photo = offers.find((o) => o.image)?.image;
    // REEA-488 item 2 — coupons that actually landed ride on the card too:
    // distinct discount(+code) pairs of this group's hits, in row order. An
    // adapter whose contract carries none still renders no coupon pill — the
    // gap its note's coverage count states.
    const couponSeen = new Map<string, Coupon>();
    for (const o of group.offers) {
      const d = o.coupon?.discount.trim();
      if (!d) continue;
      const key = `${o.coupon?.code ?? ""}|${d}`;
      if (!couponSeen.has(key))
        couponSeen.set(key, { code: o.coupon?.code ?? null, description: d, discount: d, expiresAt: null });
    }
    return {
      productId: slugify(title) || `live-${idx}`,
      title,
      brand: resolveBrand(group.brandRaw, title),
      ...(photo ? { image: photo } : {}),
      offers,
      coupons: [...couponSeen.values()],
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

/* LiveSearchResult moved to ./coverage.ts (see the note below). */

/* coverageLine + joinNames moved to ./coverage.ts so the client-rendered
   results shell imports them without dragging this server-only module (and
   its jsdom clearance hop) into the browser bundle. */

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
  /** Same promise as the last stage: the converged full-ranked snapshot —
   *  or, once the completion budget expired (REEA-398), the finalized
   *  snapshot-so-far with its honest coverage notes. */
  final: Promise<LiveSearchResult>;
  /**
   * REEA-398 — resolves once EVERY adapter has landed (also the late ones
   * that arrived after the finalized `final`). Its chain deepens the silent
   * merchants and overwrites the cache entry with the complete live answer,
   * so the follow-up feed and the next identical query get the full set.
   * Callers schedule it with Next's `after()` to keep the hop round-trips
   * alive behind the finalized response.
   */
  allSettled: Promise<void>;
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
/** REEA-486 AC-2 — one collected-at stamp per retailer answer, applied at the
 *  shared settle point so every adapter carries it symmetrically (hits come
 *  from each parser at its hop's completion, so the stamp is that retailer's
 *  real fetch time, not a later render time). */
function stampCollected(hits: SearchHit[]): SearchHit[] {
  const iso = new Date().toISOString();
  return hits.map((h) => (h.collectedAt ? h : { ...h, collectedAt: iso }));
}

async function collectSettled(
  c: RetailerCollector,
  q: string,
  fetchImpl: FetchImpl,
): Promise<SettledAdapter> {
  const asError = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  try {
    return { merchant: c.merchant, hits: stampCollected(await c.collect(q, fetchImpl)) };
  } catch (err) {
    const firstError = asError(err);
    await new Promise((r) => setTimeout(r, AMAZON_RETRY_BACKOFF_MS));
    try {
      return { merchant: c.merchant, hits: stampCollected(await c.collect(q, fetchImpl)) };
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
    // REEA-488 item 2 — coupon coverage per merchant stage: offers that
    // carried coupon info vs the merchant's total kept hits. The counts ride
    // every note a stage emits (staged and converged alike), so a gap is
    // measurable straight from the run's own diagnostics.
    const couponed = kept.reduce((n, h) => n + (h.coupon?.discount.trim() ? 1 : 0), 0);
    notes.push({
      merchant: s.merchant,
      hits: kept.length,
      coupons: couponed,
      ...(s.error ? { error: s.error } : {}),
    });
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
  // REEA-254 payload trim + REEA-488 item 1: staged flushes render through
  // the card variant, which NOW reads `alternatives` — so every flush carries
  // the cheaper same-family list from the hits collected so far. The trim the
  // flush needs is the ENTRY sharing in finalizeGroups (one distinct object
  // per referenced group, referred to afterwards), not an empty array.
  // REEA-510: intermediate flushes stay pure-live on purpose — a merchant
  // that has not answered yet at flush time is still in flight, not silent;
  // the last-seen fill lands with the converged snapshot only (finalSnapshot).
  const products = groupHits(q, hits);
  return { products, notes, suggestions: products.slice(0, 3) };
}

/**
 * REEA-398 — finalized state, served when the completion budget expired while
 * adapters were still answering: snapshot-so-far plus one honest note per
 * merchant that had not answered at finalize time, so the coverage line names
 * every gap of the FINALIZED page and carries the budget as its reason (the
 * note's error field — the same diagnosable shape a failed hop gets). A late
 * hop that lands later folds into the page through the follow-up feed, which
 * re-renders this line honestly from its own settled set.
 */
function finalizedSnapshot(
  q: string,
  country: CountryCode | null,
  collectors: RetailerCollector[],
  settledSoFar: SettledAdapter[],
  deadlineMs: number,
): LiveSearchResult {
  const snap = stagedSnapshot(q, country, settledSoFar);
  const answered = new Set(snap.notes.map((n) => n.merchant));
  for (const c of collectors) {
    if (!answered.has(c.merchant)) {
      snap.notes.push({
        merchant: c.merchant,
        hits: 0,
        coupons: 0,
        error: `no answer within the ${deadlineMs} ms completion budget`,
      });
    }
  }
  // REEA-437 — hops are still landing behind this response, so its count is
  // provisional: mark the snapshot as not-settled and let the heading keep
  // its skeleton until the converged answer (or the follow-up feed) lands.
  snap.settled = false;
  return snap;
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

/** Converged snapshot: full groupHits ranking + widened-query retry + suggestions. */
async function finalSnapshot(
  q: string,
  country: CountryCode | null,
  settled: SettledAdapter[],
  fetchImpl: FetchImpl,
  widenedRetry = false,
  snapshotsEnabled = true,
): Promise<LiveSearchResult> {
  const { hits, notes } = filterNotes(country, settled);
  let products = groupHits(q, hits);
  let servedNotes = notes;
  let attemptedQueries: string[] | undefined;
  let widenedWithAnswers = false;
  if (q && products.length === 0 && !widenedRetry) {
    // REEA-437 — one widened retry before declaring empty: whole phrases can
    // answer thin on a cold hop (retailer engines match nearly-exact phrases
    // — the same quirk REEA-357/REEA-408 worked around per adapter), so the
    // zero answer gets ONE bounded re-collect with trimmed query tokens.
    // A single-token code ("WH-1000XM6") keeps its form — there the second
    // bounded attempt itself is what a cold handshake needs: measured on the
    // deployed path, the immediate re-fetch after a budget-cut zero answers
    // fine once the discovery/handshake caches are warm. Whatever the retry
    // returns IS live data from this run — still no bundled snapshot.
    const wider = widerQuery(q);
    attemptedQueries = wider === q ? [q] : [q, wider];
    const retry = await collectLiveResults(wider, { fetchImpl, country, widenedRetry: true });
    if (retry.products.length > 0) {
      products = retry.products;
      widenedWithAnswers = true;
      // Coverage honesty: a merchant whose retry hop answered overwrites its
      // round-one note (the coverage line describes what the served cards
      // actually came from); merchants that stayed silent keep their note.
      const answeredAgain = new Map(retry.notes.map((n) => [n.merchant, n] as const));
      servedNotes = notes.map((n) => {
        const r = answeredAgain.get(n.merchant);
        return r && r.hits > 0 && !r.error ? r : n;
      });
      for (const r of retry.notes) {
        if (!servedNotes.some((n) => n.merchant === r.merchant)) servedNotes.push(r);
      }
    }
  }
  // REEA-510 — genuine empties only: merchants whose live pass kept zero
  // offers (or stayed down after both bounded attempts) fill from their ≤24 h
  // last-seen snapshot, BELOW the live rows (finalizeGroups sorts flagged
  // rows last). Only on the CONVERGED snapshot: at intermediate flushes a
  // missing merchant is still in flight, not silent. A widened retry already
  // ran the whole chain for the trimmed form — its answer carries its own
  // honest fill, so the merge is skipped when it produced products.
  // Snapshot state rides the shared last-seen store; a diagnostic chain with
  // its own injected fetchImpl observes its own hops (same rule as NO_CACHE)
  // unless it opts in explicitly through opts.snapshots.
  if (snapshotsEnabled && !widenedWithAnswers) {
    const fill = await fillSilentFromLastSeen(q, country, settled);
    if (fill.length > 0) products = groupHits(q, [...hits, ...fill]);
  }
  return { products, notes: servedNotes, suggestions: products.slice(0, 3), attemptedQueries };
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
  /**
   * REEA-398 — completion-budget ceiling in ms for the STREAM: the deadline
   * at which every stage is finalized (RESULTS_COMPLETION_BUDGET_MS by
   * default; the blocking chain passes its LIVE_SEARCH_BUDGET_MS here so the
   * finalize never cuts the blocking answer short of its documented budget).
   * Also the reason text carried by the coverage notes of a finalized-at-
   * budget snapshot. Hop fetches themselves stay bounded by opts.signal /
   * LIVE_SEARCH_BUDGET_MS so late hops can still land behind the response.
   */
  deadlineMs?: number;
  /**
   * REEA-437 — set by the widened zero-result retry itself: the retry chain
   * never widens again, so a genuinely empty shelf costs exactly TWO bounded
   * rounds (whole query + one trimmed form) instead of recursing per level.
   */
  widenedRetry?: boolean;
  /**
   * REEA-510 — last-seen snapshot participation. Default follows the memo
   * rule: production calls (no injected fetchImpl) use the shared snapshot
   * store; a diagnostic chain with its own fetchImpl observes only its own
   * hops. `true` opts a stubbed run in explicitly (tests of the fill path),
   * `false` opts a production-shaped run out.
   */
  snapshots?: boolean;
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
  // REEA-398 — TWO clocks on the staged path. The hop chain keeps the
  // documented LIVE_SEARCH_BUDGET_MS ceiling (late hops must still LAND
  // behind the finalized response, so the follow-up feed and the next query
  // get the complete live answer from the same single fan-out), while the
  // STREAM closes on the completion deadline: whatever answered by
  // RESULTS_COMPLETION_BUDGET_MS is finalized into the served document with
  // honest coverage notes, and the stream closes instead of waiting on the
  // slowest adapter. The blocking path aligns both clocks through opts.signal.
  const deadlineMs = opts.deadlineMs ?? RESULTS_COMPLETION_BUDGET_MS;
  // REEA-466 — on the staged page path the behind-the-response tail rides the
  // SAME clock the document closes on (deadline + STAGE_TAIL_HEADROOM_MS):
  // every adapter flushes as it resolves, whatever is still in flight at the
  // finalize lands inside the headroom, and the after() tail settles right
  // behind the last flush instead of holding the stream open on the 16 s
  // blocking ceiling. Callers that WAIT on the full settled answer keep their
  // documented LIVE_SEARCH_BUDGET_MS ceiling through opts.signal.
  const hopCeiling = opts.signal ?? AbortSignal.timeout(deadlineMs + STAGE_TAIL_HEADROOM_MS);
  const fetchImpl: FetchImpl = (u, init) =>
    baseFetch(u, { ...init, signal: joinSignals(hopCeiling, init?.signal ?? undefined) });
  const q = query.trim();
  const country = opts.country ?? null;
  const collectors = country
    ? COLLECTORS.filter((c) => c.country === country)
    : COLLECTORS;
  const cache = opts.cache ?? (opts.fetchImpl ? NO_CACHE : defaultQueryCache);
  // REEA-510 — same injected-fetch isolation as NO_CACHE above: stubbed runs
  // observe only their own hops; production runs share the last-seen store.
  // Tests of the fill path opt in through opts.snapshots.
  const snapshotsEnabled = opts.snapshots ?? opts.fetchImpl === undefined;
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
    return { stages: [served], final: served, allSettled: Promise.resolve() };
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

  const runs = collectors.map((c) => collectSettled(c, q, fetchImpl));
  for (const p of runs) {
    void p.then((s) => {
      settled.push(s);
      wakeReady();
    });
  }

  // REEA-398 finalize clock: every stage ALSO resolves on this timer, so the
  // streamed document closes inside the completion budget even while slow
  // hops are still in flight. At finalize time the snapshot carries everything
  // that landed plus one budget note per merchant still silent — the coverage
  // line a shopper reads at the Moment of Truth is the honest state of the
  // finalized page. Late hops keep appending to the CONVERGED chain below:
  // one fan-out feeds the finalized document, the follow-up feed, and the
  // response-cache write-through.
  const finalizeAtDeadline: Promise<LiveSearchResult> = new Promise<void>((resolve) =>
    setTimeout(resolve, deadlineMs),
  ).then(() => finalizedSnapshot(q, country, collectors, settled.slice(), deadlineMs));
  const converged: Promise<LiveSearchResult> = Promise.all(runs)
    .then(() => deepenSilent(q, settled, fetchImpl))
    // REEA-510 — publish this round's live answers as last-seen snapshots on
    // the SAME converged tail the response cache write-through rides (the
    // after() window): one write per run, behind the finalized response, so
    // the next silent pass for a retailer+query has its labeled fallback.
    .then(() => (snapshotsEnabled ? rememberRound(q, settled) : undefined))
    .then(() => finalSnapshot(q, country, settled, fetchImpl, opts.widenedRetry === true, snapshotsEnabled));

  const stages: Promise<LiveSearchResult>[] = collectors.map(async (_c, k) => {
    if (k < collectors.length - 1) {
      return await Promise.race([
        untilArrivals(k + 1).then(() => stagedSnapshot(q, country, settled.slice())),
        finalizeAtDeadline,
      ]);
    }
    return await Promise.race([converged, finalizeAtDeadline]);
  });
  const final: Promise<LiveSearchResult> = stages[stages.length - 1] ?? Promise.resolve(stagedSnapshot(q, country, settled));

  // Write-through carries the LIVE answer only (products with their scrapedAt
  // stamps included). REEA-466 (QA REEA-467 findings 2/3): the warm repeat
  // must render the COMPLETE answer, so the converged chain ALWAYS writes —
  // every hop plus the bounded widen round have answered by then, which makes
  // even its empty result an honest final state rather than a blip, and the
  // no-result page is cached like any other answer. The finalized snapshot
  // still writes as soon as it lands so an immediate repeat never re-pays the
  // fan-out — it defers only when it is a PROVISIONAL empty: hops may still
  // answer, and that run's converged snapshot overwrites it moments later
  // anyway (the hop tail now rides the completion clock). No snapshots are
  // bundled: both writes are this run's own live fetches.
  const writeLiveAnswer = (snap: LiveSearchResult): void => {
    if (snap.products.length > 0 || snap.settled !== false) cache.write(cacheKey, snap);
  };
  void final.then(writeLiveAnswer);
  void converged.then(writeLiveAnswer, () => {});
  registerFollowUp(cacheKey, converged);
  // Resolves once every hop of this run has landed (the late ones too) — the
  // results page schedules it with Next's `after()` so hop round-trips stay
  // alive behind the finalized response instead of dying with the stream.
  // REEA-466 — the after() wait is itself bounded (QA REEA-467 finding 1):
  // a hop's INTERNAL retries (challenge handshake, jsdom clearance passes)
  // keep succeeding round after round, so the abort signal cannot cut a
  // straggler that is slow-but-healthy — measured ~19-21 s until the last
  // collector settles, which held the stream open exactly that long because
  // after() awaits this promise. The race caps the behind-the-response wait
  // at the run's own ceiling plus one short margin; both chains keep running
  // either way, so late offers still land in the follow-up feed and the memo
  // while the document closes on the completion clock.
  const tailCapMs =
    (opts.signal ? opts.deadlineMs ?? LIVE_SEARCH_BUDGET_MS : deadlineMs + STAGE_TAIL_HEADROOM_MS) +
    500;
  const allSettled: Promise<void> = Promise.race([
    converged.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, tailCapMs)),
  ]);

  if (cached) {
    // Stale window only reaches here (fresh returns above): cache-first flush,
    // live stages behind it, converged full-ranked final.
    return { stages: [Promise.resolve(cached.value), ...stages], final, allSettled };
  }
  return { stages, final, allSettled };
}

/**
 * REEA-398 — pending finalized runs, one per normalized query: when a staged
 * page finalizes on the completion budget while hops are still in flight, the
 * follow-up feed (/api/results-followup) reads THIS run's converged chain to
 * fold the late offers into the open page in place — the same promise that
 * write-throughs the response cache, so one live fan-out serves the finalized
 * document, the follow-up merge, and the next identical query. Oldest-first
 * eviction keeps the map bounded (same ceiling as the response cache); reads
 * past the cache ceiling drop the entry instead of stalling the feed.
 */
const followUpRuns = new Map<string, { snap: Promise<LiveSearchResult>; startedAt: number }>();

function registerFollowUp(key: string, snap: Promise<LiveSearchResult>): void {
  followUpRuns.set(key, { snap, startedAt: Date.now() });
  if (followUpRuns.size > QUERY_CACHE_MAX_ENTRIES) {
    const oldest = followUpRuns.keys().next().value;
    if (oldest !== undefined) followUpRuns.delete(oldest);
  }
}

/** Pending converged snapshot for a query, or null when nothing is in flight.
 *  The follow-up route awaits it with its own bounded wait; a failed chain
 *  resolves to null so the finalized page simply stands on its own. */
export function followUpSnapshot(query: string): Promise<LiveSearchResult | null> | null {
  const key = queryCacheKey(query);
  const run = followUpRuns.get(key);
  if (!run) return null;
  if (Date.now() - run.startedAt > QUERY_CACHE_MAX_AGE_MS) {
    followUpRuns.delete(key);
    return null;
  }
  return run.snap.catch(() => null);
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
    // REEA-398 — the blocking caller waits for the FULL settled answer, so
    // its finalize clock rides the same hop budget: the budget-finalized
    // snapshot only replaces the converged one when the chain itself runs
    // past its own ceiling, which is the honest terminal state either way.
    deadlineMs: opts.deadlineMs ?? LIVE_SEARCH_BUDGET_MS,
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

/**
 * REEA-437 — the widened query form for the one bounded zero-result retry:
 * trim one trailing token so phrases a retailer engine matches too narrowly
 * ("iPhone 17 Pro" thin on some indexes while "iPhone 17" answers) still get
 * one broader live answer before the page declares an empty shelf. A
 * single-token query keeps its exact form — for model codes the widening is
 * the retry itself, the second bounded attempt behind warm hop caches. Shared
 * by the converged retry and its tests.
 */
export function widerQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return query.trim();
  return tokens.slice(0, -1).join(" ");
}


