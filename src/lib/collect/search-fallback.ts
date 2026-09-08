/**
 * REEA-85 — retailer-search fallback adapters.
 *
 * The seeded catalog offer URLs go stale (REEA-67) and some PDPs are
 * client-rendered, so a direct offer-URL fetch can fail to yield a price.
 * When that happens the scraper re-discovers the product via the retailer's
 * own search API and returns the live product URL it finds.
 *
 * Endpoints verified live 2026-09-05:
 *  - xcite.com: POST /api/algolia/proxy (Algolia multi-query, index
 *    xcite_prod_kw_en_main) — hits carry name/slug/price/currency/inStock.
 *  - blink.com.kw: Shopify /products.json?title= (variants[].price/available).
 *  - eureka.com.kw: Algolia index instant_records; app/search keys injected
 *    into every page as hidden inputs #cky/#srcapk (read at runtime, never
 *    hard-coded).
 *  - jarir.com: Nuxt SSR payload carries the Constructor.io index key
 *    (`"key_..."`, en preferred); query ac.cnstrc.com/search directly.
 *  - quadrastores.com: Shopify /products.json contract, same shape as blink.
 *  - nextstore.com.kw: Magento SSR search page — scan the result cards.
 *  - pckuwait.com: WooCommerce archive (`?s=…&post_type=product`) — scan the
 *    loop cards; the plain blog search view carries no prices.
 *  - luluhypermarket.com: Akinon SSR search page — read the JSON-LD Product
 *    records embedded in it.
 * All nine are documented retailer contracts (docs/RATE-LIMITS-AND-ROBOTS.md).
 * Search endpoints only — small page sizes, one call per retailer per run.
 */

import { matchesQueryToken, queryMatchTokens } from "@/lib/relevance";
import type { FetchImpl } from "@/lib/collect/scraper";


const FALLBACK_TIMEOUT_MS = 8_000;

/**
 * REEA-152 — allowlists for discovery-hop values scraped from upstream
 * homepage HTML before they are interpolated (unescaped) into the follow-up
 * hop-fetch URLs (`https://${appId}-dsn.algolia.net/...`, `...?key=${indexKey}`).
 * Each alphabet is exactly the character set real Algolia app ids, Algolia
 * search keys and Constructor index keys use, so legitimate values always
 * pass; anything else can only shrink the origin suffix `-dsn.algolia.net` /
 * the query tail, never close the origin or inject a second segment.
 * Shared single source (REEA-224 F3): live-search.ts imports these and runs
 * the same checks on its cached discovery hop.
 */
// Real Algolia app ids carry upper-case letters (eureka.com.kw ships
// "5GPHMAA239"), so the alphabet must include upper-case like SEARCH_KEY_ALLOW
// does; still only characters safe for interpolation into the hop-fetch URL.
export const APP_ID_ALLOW = /^[A-Za-z0-9-]{1,64}$/;
export const SEARCH_KEY_ALLOW = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Minimum query-token coverage for a fallback hit to count (REEA-137). Half
 * the query tokens present keeps the single-best-hit pick targeted while the
 * descriptive tail of retailer titles no longer suppresses a real match.
 */
const MIN_TOKEN_COVERAGE = 0.5;

/** Tokenizer shared by every coverage/score metric: Latin letters/digits plus
 *  the Arabic block, minimum length 2 (same shape queryMatchTokens uses). */
function matchTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 2),
  );
}

/** Token-overlap relevance of a hit title vs the product title (0..1). */
export function titleMatchScore(hitTitle: string, productTitle: string): number {
  const hits = matchTokens(hitTitle);
  const wanted = matchTokens(productTitle);
  if (hits.size === 0 || wanted.size === 0) return 0;
  let matched = 0;
  for (const t of wanted) if (hits.has(t)) matched += 1;
  return (2 * matched) / (wanted.size + hits.size);
}

export interface FoundOffer {
  price: number;
  currency: string;
  url: string;
  inStock: boolean;
  wasPrice?: number;
}

/**
 * Parse xcite's Algolia-proxy multi-query response (hits[].price/slug).
 *
 * REEA-115: xcite PDPs live under `/{slug}/p` (categories use `/c`) — the
 * storefront's own SSR payload links exactly that shape. A bare `/{slug}`
 * answers HTTP 200 with the branded "404: Page Not Found" shell, so the URL
 * built here must carry the `/p` suffix. The slug comes from the search hit,
 * never guessed, so it matches the live index.
 */
export function parseXciteSearch(payload: unknown, productTitle: string): FoundOffer | null {
  const hits =
    (payload as { results?: { hits?: Record<string, unknown>[] }[] })?.results?.[0]?.hits ?? [];
  let best: { hit: Record<string, unknown>; score: number } | null = null;
  for (const hit of hits) {
    const title = typeof hit.name === "string" ? hit.name : "";
    const price = typeof hit.price === "number" ? hit.price : NaN;
    const slug = typeof hit.slug === "string" ? hit.slug : "";
    if (!title || !Number.isFinite(price) || !slug) continue;
    if (tokenCoverage(title, productTitle) < MIN_TOKEN_COVERAGE) continue;
    const score = titleMatchScore(title, productTitle);
    if (!best || score > best.score) best = { hit, score };
  }
  const hit = best?.hit;
  if (!hit) return null;
  const unmodified = typeof hit.unmodifiedPrice === "number" ? hit.unmodifiedPrice : undefined;
  return {
    price: hit.price as number,
    currency: typeof hit.currency === "string" ? hit.currency : "KWD",
    url: `https://www.xcite.com/${hit.slug}/p`,
    inStock: hit.inStock === true || hit.status_key === "InStock",
    ...(typeof unmodified === "number" && unmodified > (hit.price as number)
      ? { wasPrice: unmodified }
      : {}),
  };
}

interface ShopifyProduct {
  title?: string;
  handle?: string;
  variants?: { price?: string; available?: boolean }[];
}


/** Parse a Shopify /products.json response (blink.com.kw, quadrastores.com). */
export function parseShopifyProducts(
  payload: unknown,
  productTitle: string,
  base = "https://blink.com.kw",
): FoundOffer | null {
  const products = (payload as { products?: ShopifyProduct[] })?.products ?? [];
  let best: { p: ShopifyProduct; score: number } | null = null;
  for (const p of products) {
    const variant = p.variants?.[0];
    const price = variant?.price != null ? Number(variant.price) : NaN;
    if (!p.title || !p.handle || !Number.isFinite(price)) continue;
    if (tokenCoverage(p.title, productTitle) < MIN_TOKEN_COVERAGE) continue;
    const score = titleMatchScore(p.title, productTitle);
    if (!best || score > best.score) best = { p, score };
  }
  const p = best?.p;
  const variant = p?.variants?.[0];
  if (!p || !variant) return null;
  return {
    price: Number(variant.price),
    currency: "KWD",
    url: `${base}/products/${p.handle}`,
    inStock: variant.available ?? true,
  };
}

interface EurekaHit {
  itmn?: string;
  objectID?: string;
  lprc?: number;
  clprc?: number;
  avaqt?: number;
}

/** Parse a eureka.com.kw Algolia response (index instant_records). */
export function parseEurekaSearch(payload: unknown, productTitle: string): FoundOffer | null {
  const hits = (payload as { hits?: EurekaHit[] })?.hits ?? [];
  let best: { hit: EurekaHit; score: number } | null = null;
  for (const hit of hits) {
    if (typeof hit.clprc !== "number" || !hit.itmn || !hit.objectID) continue;
    if (tokenCoverage(hit.itmn, productTitle) < MIN_TOKEN_COVERAGE) continue;
    const score = titleMatchScore(hit.itmn, productTitle);
    if (!best || score > best.score) best = { hit, score };
  }
  const hit = best?.hit;
  if (!hit) return null;
  return {
    price: hit.clprc as number,
    currency: "KWD",
    // The store's canonical product route is /products/details/<id>; the
    // /en/<Title>/<id> variant hard-404s on the live host (REEA-136).
    url: `https://www.eureka.com.kw/products/details/${hit.objectID}`,
    inStock: typeof hit.avaqt === "number" ? hit.avaqt > 0 : true,
    ...(typeof hit.lprc === "number" && hit.lprc > (hit.clprc as number) ? { wasPrice: hit.lprc } : {}),
  };
}

/**
 * jarir.com is a Nuxt storefront whose search hits are fetched client-side
 * from Constructor.io. The per-language index keys are injected into every
 * SSR page's __NUXT_DATA__ payload (resolved `searchProviderKeys` values
 * appear as `"key_..."` literals right after the config anchor), so we read
 * them at runtime like eureka's hidden inputs — never hard-coded.
 *
 * The payload stores {ar, en} in reference order: the FIRST literal answers
 * Arabic-script queries with the storefront's Arabic titles (brand field
 * included), the LAST answers Latin queries with English titles. REEA-195:
 * the Arabic index is the right hop for Arabic-script queries — the Latin one
 * answers them with unrelated filler — while Latin-script queries keep the
 * existing English pick.
 */
export function extractJarirIndexKey(html: string, lang: "ar" | "en" = "en"): string | null {
  const anchor = html.indexOf("searchProviderKeys");
  const haystack = anchor >= 0 ? html.slice(anchor) : html;
  const keys = [...haystack.matchAll(/"(key_[A-Za-z0-9_-]{6,})"/g)].map((m) => m[1]);
  if (keys.length === 0) return null;
  return lang === "ar" ? keys[0] : keys[keys.length - 1];
}

/** Index language for a query: Arabic-script text rides jarir's Arabic
 *  index, anything else the English one. */
export function jarirIndexLang(query: string): "ar" | "en" {
  return /[\u0600-\u06FF]/.test(query) ? "ar" : "en";
}

interface ConstructorHit {
  data?: {
    url?: string;
    price?: number | string;
    metadata?: { name?: string; price?: string };
  };
}

/** Parse a Constructor.io search response (jarir.com storefront provider). */
export function parseJarirSearch(payload: unknown, productTitle: string): FoundOffer | null {
  const results =
    (payload as { response?: { results?: ConstructorHit[] } })?.response?.results ?? [];
  let best: { hit: ConstructorHit; score: number } | null = null;
  for (const hit of results) {
    const data = hit?.data;
    const price = typeof data?.price === "number" ? data.price : Number(data?.metadata?.price);
    const title = data?.metadata?.name ?? "";
    const slug = data?.url ?? "";
    if (!Number.isFinite(price) || price <= 0 || !title || !slug) continue;
    if (tokenCoverage(title, productTitle) < MIN_TOKEN_COVERAGE) continue;
    const score = titleMatchScore(title, productTitle);
    if (!best || score > best.score) best = { hit, score };
  }
  const data = best?.hit?.data;
  if (!data) return null;
  const price = typeof data.price === "number" ? data.price : Number(data.metadata?.price);
  return {
    price,
    currency: "SAR",
    url: `https://www.jarir.com/${data.url}`,
    // Constructor indexes sellable items only; stock-out state is not exposed
    // in the hit fields — listed-with-price implies purchasable (same rule as
    // extractInStock's unknown branch).
    inStock: true,
  };
}

interface AmazonCard {
  title: string;
  price: number;
  path: string;
  outOfStock: boolean;
}

/** Arabic-Indic digits appear in some amazon.eg renders — normalize before parsing. */
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

/**
 * Coverage of product-title tokens found in a hit title (0..1) — the share of
 * query tokens the title actually answers.
 *
 * REEA-137: coverage is the acceptance bar for every retailer parser because
 * the symmetric F-score (`titleMatchScore`) punishes long descriptive titles
 * purely for their extra tokens — a one-word brand query ("samsung") silently
 * dropped whole retailers whose index titles are verbose: "Samsung Galaxy
 * A17 5G, 256 GB, 8 GB RAM, Grey, 5G, Exynos 1330" scored ~0.18 even though
 * every query token matched. Coverage asks the question that matters for a
 * search hit — is the query contained in the title — without penalising the
 * descriptive tail (same reasoning parseAmazonEgSearch already documents).
 */
export function tokenCoverage(hitTitle: string, productTitle: string): number {
  const hitTokens = hitTitle.toLowerCase();
  const wanted = Array.from(matchTokens(productTitle));
  if (wanted.length === 0) return 0;
  let matched = 0;
  for (const t of wanted) if (hitTokens.includes(t)) matched += 1;
  return matched / wanted.length;
}

/**
 * REEA-195 — coverage gate for Arabic-script queries: same acceptance math as
 * tokenCoverage, except an Arabic brand spelling may also be answered by the
 * brand's curated Latin form ("أبل" ⇄ "Apple"). Without that bridge a Kuwaiti
 * Arabic brand query is dropped by every English-index retailer (their titles
 * are Latin-script, so plain coverage is 0 for all of them) and the shopper
 * waits ~5 s for the few Arabic-script listings that survive — the timing gap
 * REEA-195 measured. Non-brand tokens and Latin queries take the identical
 * plain-substring path, so their behavior is untouched.
 */
export function brandAwareCoverage(hitTitle: string, query: string): number {
  const hitTokens = hitTitle.toLowerCase();
  const wanted = queryMatchTokens(query);
  if (wanted.length === 0) return 0;
  let matched = 0;
  for (const t of wanted) if (matchesQueryToken(hitTokens, t)) matched += 1;
  return matched / wanted.length;
}

/** Parse an amazon.eg `/s?k=` results page into best-matching offer. */
export function parseAmazonEgSearch(html: string, productTitle: string): FoundOffer | null {
  const cards: AmazonCard[] = [];
  for (const seg of html.split('data-component-type="s-search-result"').slice(1)) {
    const asin = seg.match(/\/dp\/([A-Z0-9-]{6,12})/)?.[1];
    const priceRaw = normalizeDigits(
      // Live pages render `>EGP 3,957.00` / `>List: EGP 4,667.00` — take the
      // first digit run inside the offscreen span, whatever the currency prefix.
      seg.match(/class="a-offscreen">[^<]*?([\d٠-٩][٠-٩\d.,]*)/)?.[1] ?? "",
    );
    if (!asin || !priceRaw) continue;
    const price = Number.parseFloat(priceRaw.replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    const h2 = seg.match(/<h2[^>]*>([\s\S]{0,400}?)<\/h2>/);
    // Live cards keep only the brand inside <h2>; the full title sits in the
    // aria-label — prefer it, fall back to the inner text.
    const title = (seg.match(/<h2[^>]*aria-label="([^"]+)"/)?.[1] ?? h2?.[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    cards.push({ title, price, path: `/dp/${asin}`, outOfStock: /غير متوفر|out of stock/i.test(seg) });
  }
  if (cards.length === 0) return null;
  // Titles mix Arabic and Latin script, so F-score is too punitive across
  // scripts: rank by token coverage and fall back to Amazon's own result
  // order (cards are already relevance-ranked) when nothing covers the title.
  let bestIdx = -1;
  let bestScore = 0;
  cards.forEach((c, i) => {
    const s = tokenCoverage(c.title, productTitle);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  });
  const card = bestIdx >= 0 ? cards[bestIdx] : cards.find((c) => !c.outOfStock) ?? cards[0];
  return {
    price: card.price,
    currency: "EGP",
    url: `https://www.amazon.eg${card.path}`,
    inStock: !card.outOfStock,
  };
}

interface SultanCenterItem {
  name?: string;
  slug?: string;
  price?: string;
  spclprice?: string;
  is_in_stock?: string;
  currencysymbol?: string;
}

/** Parse a sultan-center.com mobile/api/search response (product_list). */
export function parseSultanCenterSearch(payload: unknown, productTitle: string): FoundOffer | null {
  const list =
    (payload as { products?: { product_list?: SultanCenterItem[] } })?.products?.product_list ?? [];
  let best: { item: SultanCenterItem; score: number } | null = null;
  for (const item of list) {
    const price = Number(item?.price);
    if (!item?.name || !item.slug || !Number.isFinite(price) || price <= 0) continue;
    if (tokenCoverage(item.name, productTitle) < MIN_TOKEN_COVERAGE) continue;
    const score = titleMatchScore(item.name, productTitle);
    if (!best || score > best.score) best = { item, score };
  }
  const item = best?.item;
  if (!item) return null;
  const regular = Number(item.price);
  const special = item.spclprice ? Number(item.spclprice) : NaN;
  const promo = Number.isFinite(special) && special > 0 && special < regular;
  return {
    price: promo ? special : regular,
    // Grocery prices on this storefront are quoted in KD (= KWD).
    currency: item.currencysymbol && item.currencysymbol !== "KD" ? item.currencysymbol : "KWD",
    url: `https://www.sultan-center.com/product/${item.slug}`,
    // Listed-with-price implies purchasable (same rule as extractInStock).
    inStock: item.is_in_stock === undefined ? true : Number(item.is_in_stock) > 0,
    ...(promo ? { wasPrice: regular } : {}),
  };
}

/** Decode the numeric/named HTML entities retailer titles actually ship. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize "1,234.500" price text to a number. */
function priceNumber(raw: string | undefined): number {
  if (!raw) return NaN;
  return Number.parseFloat(raw.replace(/,/g, "").trim());
}

export interface NextStoreCard {
  title: string;
  url: string;
  brand?: string;
  price: number;
  currency: string;
  wasPrice?: number;
  inStock: boolean;
}

/**
 * Scan a Magento catalogsearch results page into product cards. Cards carry
 * the link anchor inside `<strong class="product name product-item-name">`,
 * the brand anchor right after it, and a price-box whose spans expose
 * `data-price-amount` with `data-price-type` finalPrice / oldPrice — the same
 * two amounts the storefront itself renders as sale/reg price. Shared by the
 * live collector (live-search.ts) and the per-product fallback below.
 */
export function scanNextStoreCards(html: string): NextStoreCard[] {
  const out: NextStoreCard[] = [];
  const segments = html.split('class="product-item-link"').slice(1);
  for (const seg of segments) {
    const attrTitle = decodeEntities(seg.match(/title="([^"]+)"/)?.[1] ?? "");
    const innerTitle = decodeEntities(seg.match(/^[^>]*>([^<]+)</)?.[1] ?? "");
    const title = attrTitle || innerTitle;
    const url = seg.match(/href="([^"]+)"/)?.[1] ?? "";
    if (!title || !url) continue;
    let price = NaN;
    let wasPrice: number | undefined;
    for (const m of seg.matchAll(/data-price-amount="([\d.,]+)"[^>]*data-price-type="(finalPrice|oldPrice)"/g)) {
      const value = priceNumber(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (m[2] === "finalPrice") price = value;
      else wasPrice = value;
    }
    if (!Number.isFinite(price) || price <= 0) {
      const plain = seg.match(/class="price">KD? ?([\d.,]+)/);
      price = priceNumber(plain?.[1]);
      if (!Number.isFinite(price) || price <= 0) continue;
    }
    const brand = decodeEntities(seg.match(/class="product-item-brand"[^>]*>([^<]+)</)?.[1] ?? "");
    out.push({
      title,
      url,
      ...(brand ? { brand } : {}),
      price,
      currency: "KWD",
      ...(wasPrice != null && wasPrice > price ? { wasPrice } : {}),
      // Listed-with-price implies purchasable unless the card says otherwise.
      inStock: !/out of stock/i.test(seg),
    });
  }
  return out;
}

export interface WooCard {
  title: string;
  url: string;
  price: number;
  currency: string;
  wasPrice?: number;
  inStock: boolean;
}

/**
 * Scan a WooCommerce/Electro-style archive page into product cards. Each card
 * links via `woocommerce-loop-product__link` onto an h2 title, then renders
 * prices as `<ins>` (sale price) around `<del>` (regular price) bdi amounts —
 * a lone price span when no promo runs. Currency symbol arrives inline ("KD");
 * KD is the local spelling of KWD. Shared by the live collector and the
 * per-product fallback below.
 */
export function scanWooCards(html: string): WooCard[] {
  const out: WooCard[] = [];
  const titleRe = /class="woocommerce-loop-product__title"[^>]*>([\s\S]{0,400}?)<\/h2>/g;
  for (const m of html.matchAll(titleRe)) {
    const title = decodeEntities(m[1].replace(/<[^>]+>/g, " "));
    if (!title) continue;
    const before = html.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
    const url = [...before.matchAll(/href="([^"]+)"/g)].pop()?.[1] ?? "";
    if (!url) continue;
    const nextTitle = html.indexOf('class="woocommerce-loop-product__title"', (m.index ?? 0) + 1);
    const windowHtml = html.slice(
      m.index ?? 0,
      nextTitle < 0 ? (m.index ?? 0) + 4000 : Math.min(nextTitle, (m.index ?? 0) + 4000),
    );
    const amountRe = /woocommerce-Price-currencySymbol[^>]*>([^<]*)<\/span>&nbsp;([\d.,]+)/;
    const ins = windowHtml.match(/<ins>[\s\S]*?<\/ins>/)?.[0];
    const del = windowHtml.match(/<del>[\s\S]*?<\/del>/)?.[0];
    const current = priceNumber(ins?.match(amountRe)?.[2] ?? windowHtml.match(amountRe)?.[2]);
    if (!Number.isFinite(current) || current <= 0) continue;
    const was = priceNumber(del?.match(amountRe)?.[2]);
    const symbol = ins?.match(amountRe)?.[1] ?? windowHtml.match(amountRe)?.[1] ?? "";
    const trimmed = symbol.trim();
    const currency = trimmed === "" || trimmed.toUpperCase() === "KD" ? "KWD" : trimmed.toUpperCase();
    out.push({
      title,
      url,
      price: current,
      currency,
      ...(Number.isFinite(was) && was > current ? { wasPrice: was } : {}),
      inStock: !/out of stock/i.test(windowHtml),
    });
  }
  return out;
}

export interface JsonLdProduct {
  title: string;
  url: string;
  price: number;
  currency?: string;
  wasPrice?: number;
  inStock: boolean;
}

/**
 * Read JSON-LD Product records out of an SSR page (luluhypermarket.com ships
 * them in its search results). Walks ItemList/@graph/array wrappers, keeps
 * the first priced offer per product; availability follows the schema.org
 * InStock/OutOfStock vocabulary. Shared by the live collector and the
 * per-product fallback below.
 */
export function extractJsonLdProducts(html: string): JsonLdProduct[] {
  const out: JsonLdProduct[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    for (const record of jsonLdProducts(parsed)) {
      const title = typeof record.name === "string" ? decodeEntities(record.name) : "";
      if (!title) continue;
      const offers = Array.isArray(record.offers) ? record.offers[0] : record.offers;
      const offer = (offers ?? {}) as Record<string, unknown>;
      const price = Number(offer.price ?? record.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const currency = typeof offer.priceCurrency === "string" ? offer.priceCurrency : undefined;
      const availability = typeof offer.availability === "string" ? offer.availability : "";
      const url =
        typeof offer.url === "string" && offer.url
          ? offer.url
          : typeof record.url === "string"
            ? record.url
            : typeof record["@id"] === "string"
              ? record["@id"]
              : "";
      const wasRaw = Number(offer.strikethroughPrice ?? offer.oldPrice ?? offer.compareAtPrice);
      out.push({
        title,
        url,
        price,
        ...(currency ? { currency } : {}),
        ...(Number.isFinite(wasRaw) && wasRaw > price ? { wasPrice: wasRaw } : {}),
        // Absent availability reads as purchasable (listed-with-price rule);
        // the explicit OutOfStock tail is the only negative case — everything
        // else (InStock, Discontinued still listed) keeps the offer live.
        inStock: availability === "" ? true : !availability.endsWith("OutOfStock"),
      });
    }
  }
  return out;
}

function jsonLdProducts(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(jsonLdProducts);
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  if (typeof record["@type"] === "string" && /\bProduct\b/.test(record["@type"])) return [record];
  const children: unknown[] = [];
  if (record["@graph"]) children.push(record["@graph"]);
  if (record.itemListElement) children.push(record.itemListElement);
  if (record.item) children.push(record.item);
  return children.flatMap(jsonLdProducts);
}

/** Pick the best-covering card as the single fallback offer. */
function bestFromCards(
  cards: { title: string; url: string; price: number; currency: string; wasPrice?: number; inStock: boolean }[],
  productTitle: string,
): FoundOffer | null {
  if (cards.length === 0) return null;
  const scored = cards.filter((c) => tokenCoverage(c.title, productTitle) >= MIN_TOKEN_COVERAGE);
  const pool = scored.length > 0 ? scored : cards;
  let bestIdx = 0;
  let bestScore = -1;
  pool.forEach((c, i) => {
    const s = titleMatchScore(c.title, productTitle);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  });
  const chosen = pool.find((c) => !c.inStock && bestScore < MIN_TOKEN_COVERAGE) ?? pool[bestIdx];
  return {
    price: chosen.price,
    currency: chosen.currency,
    url: chosen.url,
    inStock: chosen.inStock,
    ...(chosen.wasPrice != null ? { wasPrice: chosen.wasPrice } : {}),
  };
}

/** Parse a nextstore.com.kw catalogsearch page into the best offer. */
export function parseNextStoreSearch(html: string, productTitle: string): FoundOffer | null {
  return bestFromCards(scanNextStoreCards(html), productTitle);
}

/** Parse a pckuwait.com product-archive page into the best offer. */
export function parsePcKuwaitSearch(html: string, productTitle: string): FoundOffer | null {
  return bestFromCards(scanWooCards(html), productTitle);
}

/** Parse a luluhypermarket.com SSR page JSON-LD into the best offer. */
export function parseLuluSearch(html: string, productTitle: string): FoundOffer | null {
  const cards = extractJsonLdProducts(html).map((item) => ({
    title: item.title,
    url: item.url.startsWith("http") ? item.url : `https://www.luluhypermarket.com${item.url}`,
    price: item.price,
    currency: item.currency ?? "KWD",
    inStock: item.inStock,
    ...(item.wasPrice != null ? { wasPrice: item.wasPrice } : {}),
  }));
  return bestFromCards(cards, productTitle);
}

/**
 * Browser-shaped header set for the two Cloudflare-fronted hops (verified
 * live 2026-09-08): the managed challenge only steps aside for a coherent
 * browser header combination — a bare bot UA stays pinned on the
 * interstitial. Shared by the live collectors and the fallback dispatch so
 * both paths present the same identity.
 */
export const CHALLENGE_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

/**
 * Challenge-tolerant GET for the Cloudflare-fronted retailers: the first
 * hits answer with a challenge interstitial while seeding the visitor
 * cookie; replaying that cookie on a bounded retry lands on the real SSR
 * page within seconds. Attempts are bounded to what fits the hop window
 * (~250ms apart), and the seeded cookie is kept per host afterwards, so a
 * warm server answers its very first attempt — each retailer gets one
 * handshake per TTL window, not one per query. When no attempt succeeds the
 * caller still gets its HTTP note (graceful degradation unchanged).
 */
const CHALLENGE_COOKIE_TTL_MS = 10 * 60_000;
const challengeCookies = new Map<string, { header: string; expiresAt: number }>();

export function fetchThroughChallenge(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return runAttempts(fetchImpl, url, init, signal);
}

async function runAttempts(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const host = new URL(url).host;
  let warm = challengeCookies.get(host);
  if (warm && warm.expiresAt < Date.now()) {
    challengeCookies.delete(host);
    warm = undefined;
  }
  const jar = new Map<string, string>();
  if (warm) for (const kv of warm.header.split("; ")) {
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6 && !signal.aborted; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
    if (signal.aborted) break;
    const headers = new Headers(init.headers);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetchImpl(url, { ...init, headers, cache: "no-store", signal });
    lastStatus = res.status;
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const kv = sc.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    if (jar.size > 0) {
      challengeCookies.set(host, {
        header: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        expiresAt: Date.now() + CHALLENGE_COOKIE_TTL_MS,
      });
    }
    if (res.ok) return res;
  }
  throw new Error(`HTTP ${lastStatus}`);
}

/** fetch with a hard timeout, returning the raw Response. */
async function fetchResponse(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs = FALLBACK_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-store: Next server-side fetch may otherwise replay the direct-fetch
    // response (same URL) for fallback retries, so a transient apology page
    // would survive into every attempt. Fallback reads must be fresh.
    return await fetchImpl(url, { ...init, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  fetchImpl: FetchImpl,
  url: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetchResponse(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`search fallback HTTP ${res.status}`);
  return res.json();
}

/**
 * Re-discover a product on its retailer by title search. Returns the best
 * matching live offer, or null when the retailer has no search adapter.
 * Any error propagates to the caller — the subtask surfaces it (AC6).
 */
export async function searchRetailerFallback(
  host: string,
  productTitle: string,
  fetchImpl: FetchImpl,
): Promise<FoundOffer> {
  if (host.endsWith("xcite.com")) {
    const payload = await postJson(fetchImpl, "https://www.xcite.com/api/algolia/proxy", {
      requests: [
        { indexName: "xcite_prod_kw_en_main", params: { query: productTitle, hitsPerPage: 8 } },
      ],
    });
    const found = parseXciteSearch(payload, productTitle);
    if (!found) throw new Error("No matching product found on xcite search");
    return found;
  }
  if (host.endsWith("blink.com.kw")) {
    const res = await fetchResponse(
      fetchImpl,
      `https://blink.com.kw/products.json?title=${encodeURIComponent(productTitle)}&limit=8`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`blink search HTTP ${res.status}`);
    const found = parseShopifyProducts(await res.json(), productTitle);
    if (!found) throw new Error("No matching product found on blink search");
    return found;
  }
  if (host.endsWith("eureka.com.kw")) {
    // Two-step: the Algolia app/search keys are injected into every page.
    const page = await fetchResponse(fetchImpl, "https://www.eureka.com.kw/", {
      headers: { accept: "text/html" },
    });
    if (!page.ok) throw new Error(`eureka homepage HTTP ${page.status}`);
    const html = await page.text();
    const appId = html.match(/id="cky"[^>]*value="([^"]+)"/)?.[1];
    const searchKey = html.match(/id="srcapk"[^>]*value="([^"]+)"/)?.[1];
    if (!appId || !searchKey) throw new Error("eureka: algolia credentials not found on page");
    if (!APP_ID_ALLOW.test(appId) || !SEARCH_KEY_ALLOW.test(searchKey)) {
      // REEA-224 F3 — same REEA-152 allowlist live-search.ts runs: fail closed
      // BEFORE interpolating, so a crafted homepage never reaches the hop URL.
      throw new Error("eureka: discovery credentials failed validation");
    }
    const payload = await postJson(
      fetchImpl,
      `https://${appId}-dsn.algolia.net/1/indexes/instant_records/query` +
        `?x-algolia-application-id=${appId}&x-algolia-api-key=${searchKey}`,
      { params: `query=${encodeURIComponent(productTitle)}&hitsPerPage=8` },
    );
    const found = parseEurekaSearch(payload, productTitle);
    if (!found) throw new Error("No matching product found on eureka search");
    return found;
  }
  if (host.endsWith("sultan-center.com")) {
    // Store-scoped payload exactly as the storefront's own SPA sends it
    // (captured live 2026-09-07): store 1 / substore 45 answers for every
    // Kuwait area; the store front renders product pages under /product/<slug>.
    const payload = await postJson(fetchImpl, "https://www.sultan-center.com/mobile/api/search", {
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
      search_data: productTitle,
      pagesize: 8,
      area: "",
      uid: null,
      deviceId: "reemco-web",
      is_web: 1,
      store_type: "ecom",
      latitude: "",
      longitude: "",
      isDesktop: "Desktop",
    });
    const found = parseSultanCenterSearch(payload, productTitle);
    if (!found) throw new Error("No matching product found on sultan-center search");
    return found;
  }
  if (host.endsWith("jarir.com")) {
    // Two-step like eureka: read the Constructor index key from any SSR page,
    // then query the storefront's own search API. Arabic-script titles ride
    // the ar index, Latin titles the en one (see jarirIndexLang).
    const page = await fetchResponse(fetchImpl, "https://www.jarir.com/", {
      headers: { accept: "text/html" },
    });
    if (!page.ok) throw new Error(`jarir homepage HTTP ${page.status}`);
    const indexKey = extractJarirIndexKey(await page.text(), jarirIndexLang(productTitle));
    if (!indexKey) throw new Error("jarir: constructor index key not found on page");
    if (!SEARCH_KEY_ALLOW.test(indexKey)) {
      // REEA-224 F3 — same shared allowlist as the eureka hop and live-search.
      throw new Error("jarir: constructor index key failed validation");
    }
    const payload = await fetchResponse(
      fetchImpl,
      `https://ac.cnstrc.com/search/${encodeURIComponent(productTitle)}` +
        `?key=${indexKey}&num_results_per_page=8`,
      { headers: { accept: "application/json" } },
    ).then((res) => {
      if (!res.ok) throw new Error(`jarir search HTTP ${res.status}`);
      return res.json();
    });
    const found = parseJarirSearch(payload, productTitle);
    if (!found) throw new Error("No matching product found on jarir search");
    return found;
  }
  if (host.endsWith("amazon.eg")) {
    // amazon.eg intermittently answers with a "عذرًا!" apology interstitial
    // (HTTP 200, zero result cards) that resolves on an immediate re-fetch;
    // Accept-Language: en makes the full SSR results page markedly more
    // consistent than the default ar-ae render. Two attempts fit well inside
    // the per-retailer budget (each fetch caps at FALLBACK_TIMEOUT_MS).
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchResponse(
        fetchImpl,
        `https://www.amazon.eg/s?k=${encodeURIComponent(productTitle)}`,
        {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en",
            "user-agent": "Mozilla/5.0",
          },
        },
      );
      if (!res.ok) {
        lastError = `amazon.eg search HTTP ${res.status}`;
        if (attempt < 1) await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      const found = parseAmazonEgSearch(await res.text(), productTitle);
      if (found) return found;
      lastError = "No matching product found on amazon.eg search";
      // A just-warmed edge can serve two identical cold responses back to
      // back; ~300ms lets amazon.eg's own cache catch up before retrying.
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(lastError);
  }
  if (host.endsWith("quadrastores.com")) {
    // Same Shopify contract as blink — one GET, shared parser.
    const res = await fetchResponse(
      fetchImpl,
      `https://quadrastores.com/products.json?title=${encodeURIComponent(productTitle)}&limit=8`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`quadra search HTTP ${res.status}`);
    const found = parseShopifyProducts(await res.json(), productTitle, "https://quadrastores.com");
    if (!found) throw new Error("No matching product found on Quadra Stores search");
    return found;
  }
  if (host.endsWith("nextstore.com.kw")) {
    // Magento SSR results page behind a Cloudflare managed challenge; the
    // bounded cookie-carry retry in fetchThroughChallenge lands the SSR HTML.
    const res = await fetchThroughChallenge(
      fetchImpl,
      `https://www.nextstore.com.kw/catalogsearch/result/index/?q=${encodeURIComponent(productTitle)}`,
      { headers: { ...CHALLENGE_HEADERS } },
      AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
    );
    const found = parseNextStoreSearch(await res.text(), productTitle);
    if (!found) throw new Error("No matching product found on Next Store search");
    return found;
  }
  if (host.endsWith("pckuwait.com")) {
    // post_type=product lands on the WooCommerce archive — the plain blog
    // search view carries no prices.
    const res = await fetchResponse(
      fetchImpl,
      `https://pckuwait.com/?s=${encodeURIComponent(productTitle)}&post_type=product`,
      { headers: { accept: "text/html,application/xhtml+xml", "accept-language": "en" } },
    );
    if (!res.ok) throw new Error(`pckuwait search HTTP ${res.status}`);
    const found = parsePcKuwaitSearch(await res.text(), productTitle);
    if (!found) throw new Error("No matching product found on PC Kuwait search");
    return found;
  }
  if (host.endsWith("luluhypermarket.com")) {
    // Akinon SSR search page on the same Cloudflare managed-challenge setup
    // as nextstore — same bounded retry and browser header set.
    const res = await fetchThroughChallenge(
      fetchImpl,
      `https://www.luluhypermarket.com/en/search?query=${encodeURIComponent(productTitle)}`,
      { headers: { ...CHALLENGE_HEADERS } },
      AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
    );
    const found = parseLuluSearch(await res.text(), productTitle);
    if (!found) throw new Error("No matching product found on lulu search");
    return found;
  }
  throw new Error(`No search fallback for ${host}`);
}
