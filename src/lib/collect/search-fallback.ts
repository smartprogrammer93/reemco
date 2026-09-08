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
 *  - sultan-center.com: Vue SPA storefront; POST mobile/api/search with the
 *    store-scoped payload the SPA itself sends (store 1, substore 45); hits
 *    arrive under products.product_list with slug-based /product/<slug> PDPs.
 *  - amazon.eg: no JSON contract — parse the `/s?k=` results HTML cards.
 * All six are documented retailer contracts (docs/RATE-LIMITS-AND-ROBOTS.md).
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

/** Parse a Shopify /products.json response (blink.com.kw). */
export function parseShopifyProducts(payload: unknown, productTitle: string): FoundOffer | null {
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
    url: `https://blink.com.kw/products/${p.handle}`,
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
  throw new Error(`No search fallback for ${host}`);
}
