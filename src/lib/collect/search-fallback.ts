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
 * All three are documented retailer contracts (docs/RATE-LIMITS-AND-ROBOTS.md).
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
    return await fetchImpl(url, { ...init, signal: controller.signal });
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
  throw new Error(`No search fallback for ${host}`);
}
