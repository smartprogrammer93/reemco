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
 *  - amazon.eg: no JSON contract — parse the `/s?k=` results HTML cards.
 * All five are documented retailer contracts (docs/RATE-LIMITS-AND-ROBOTS.md).
 * Search endpoints only — small page sizes, one call per retailer per run.
 */
import type { FetchImpl } from "@/lib/collect/scraper";


const FALLBACK_TIMEOUT_MS = 8_000;

/** Token-overlap relevance of a hit title vs the product title (0..1). */
export function titleMatchScore(hitTitle: string, productTitle: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
        .split(" ")
        .filter((t) => t.length >= 2),
    );
  const hits = tokens(hitTitle);
  const wanted = tokens(productTitle);
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

/** Parse xcite's Algolia-proxy multi-query response (hits[].price/slug). */
export function parseXciteSearch(payload: unknown, productTitle: string): FoundOffer | null {
  const hits =
    (payload as { results?: { hits?: Record<string, unknown>[] }[] })?.results?.[0]?.hits ?? [];
  let best: { hit: Record<string, unknown>; score: number } | null = null;
  for (const hit of hits) {
    const title = typeof hit.name === "string" ? hit.name : "";
    const price = typeof hit.price === "number" ? hit.price : NaN;
    const slug = typeof hit.slug === "string" ? hit.slug : "";
    if (!title || !Number.isFinite(price) || !slug) continue;
    const score = titleMatchScore(title, productTitle);
    if (score > 0.3 && (!best || score > best.score)) best = { hit, score };
  }
  const hit = best?.hit;
  if (!hit) return null;
  const unmodified = typeof hit.unmodifiedPrice === "number" ? hit.unmodifiedPrice : undefined;
  return {
    price: hit.price as number,
    currency: typeof hit.currency === "string" ? hit.currency : "KWD",
    url: `https://www.xcite.com/${hit.slug}`,
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
    const score = titleMatchScore(p.title, productTitle);
    if (score > 0.3 && (!best || score > best.score)) best = { p, score };
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
    const score = titleMatchScore(hit.itmn, productTitle);
    if (score > 0.3 && (!best || score > best.score)) best = { hit, score };
  }
  const hit = best?.hit;
  if (!hit) return null;
  return {
    price: hit.clprc as number,
    currency: "KWD",
    url: `https://www.eureka.com.kw/en/${(hit.itmn as string).trim().replace(/\s+/g, "_")}/${hit.objectID}`,
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
 */
export function extractJarirIndexKey(html: string): string | null {
  const anchor = html.indexOf("searchProviderKeys");
  const haystack = anchor >= 0 ? html.slice(anchor) : html;
  const keys = [...haystack.matchAll(/"(key_[A-Za-z0-9_-]{6,})"/g)].map((m) => m[1]);
  if (keys.length === 0) return null;
  // The payload stores {ar, en} in reference order, so the last literal is
  // the English index — a better match for the Latin-script catalog titles.
  return keys[keys.length - 1];
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
    const score = titleMatchScore(title, productTitle);
    if (score > 0.3 && (!best || score > best.score)) best = { hit, score };
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

/** Coverage of product-title tokens found in a hit title (0..1). */
function tokenCoverage(hitTitle: string, productTitle: string): number {
  const hitTokens = hitTitle.toLowerCase();
  const wanted = Array.from(
    new Set(
      productTitle
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
        .split(" ")
        .filter((t) => t.length >= 2),
    ),
  );
  if (wanted.length === 0) return 0;
  let matched = 0;
  for (const t of wanted) if (hitTokens.includes(t)) matched += 1;
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
  if (host.endsWith("jarir.com")) {
    // Two-step like eureka: read the Constructor index key from any SSR page,
    // then query the storefront's own search API.
    const page = await fetchResponse(fetchImpl, "https://www.jarir.com/", {
      headers: { accept: "text/html" },
    });
    if (!page.ok) throw new Error(`jarir homepage HTTP ${page.status}`);
    const indexKey = extractJarirIndexKey(await page.text());
    if (!indexKey) throw new Error("jarir: constructor index key not found on page");
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
