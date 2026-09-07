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
import { extractJarirIndexKey, titleMatchScore } from "@/lib/collect/search-fallback";
import type { FetchImpl } from "@/lib/collect/scraper";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/** Per-attempt fetch ceiling for the search fan-out (parallel per retailer). */
export const LIVE_SEARCH_TIMEOUT_MS = 3_500;
/** Hard ceiling for the whole fan-out, enforced via AbortController below. */
export const LIVE_SEARCH_BUDGET_MS = 7_500;
/** Cap of distinct product groups served per query. */
export const LIVE_SEARCH_MAX_PRODUCTS = 20;

export interface SearchHit {
  title: string;
  merchant: string;
  price: number;
  currency: string;
  url: string;
  inStock: boolean;
  wasPrice?: number;
}

/** Minimum title/query relevance for a hit to be served as a result. */
const MIN_SCORE = 0.25;

interface RetailerCollector {
  merchant: string;
  collect: (query: string, fetchImpl: FetchImpl) => Promise<SearchHit[]>;
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

export function xciteHits(payload: unknown, query: string): SearchHit[] {
  const hits =
    (payload as { results?: { hits?: Record<string, unknown>[] }[] })?.results?.[0]?.hits ?? [];
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const title = typeof hit.name === "string" ? hit.name : "";
    const price = typeof hit.price === "number" ? hit.price : NaN;
    const slug = typeof hit.slug === "string" ? hit.slug : "";
    if (!title || !Number.isFinite(price) || price <= 0 || !slug) continue;
    if (titleMatchScore(title, query) < MIN_SCORE) continue;
    const unmodified = typeof hit.unmodifiedPrice === "number" ? hit.unmodifiedPrice : undefined;
    out.push({
      title,
      merchant: "Xcite",
      price,
      currency: typeof hit.currency === "string" ? hit.currency : "KWD",
      url: `https://www.xcite.com/${slug}/p`,
      inStock: hit.inStock === true || hit.status_key === "InStock",
      ...(unmodified != null && unmodified > price ? { wasPrice: unmodified } : {}),
    });
  }
  return out;
}

export function blinkHits(payload: unknown, query: string): SearchHit[] {
  const products =
    (payload as { products?: { title?: string; handle?: string; variants?: { price?: string; available?: boolean }[] }[] })
      ?.products ?? [];
  const out: SearchHit[] = [];
  for (const p of products) {
    const variant = p.variants?.[0];
    const price = variant?.price != null ? Number(variant.price) : NaN;
    if (!p.title || !p.handle || !Number.isFinite(price) || price <= 0) continue;
    if (titleMatchScore(p.title, query) < MIN_SCORE) continue;
    out.push({
      title: p.title,
      merchant: "Blink",
      price,
      currency: "KWD",
      url: `https://blink.com.kw/products/${p.handle}`,
      inStock: variant?.available ?? true,
    });
  }
  return out;
}

export function eurekaHits(payload: unknown, query: string): SearchHit[] {
  const hits =
    (payload as { hits?: { itmn?: string; objectID?: string; lprc?: number; clprc?: number; avaqt?: number }[] })
      ?.hits ?? [];
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (!hit.itmn || !hit.objectID || typeof hit.clprc !== "number" || hit.clprc <= 0) continue;
    if (titleMatchScore(hit.itmn, query) < MIN_SCORE) continue;
    out.push({
      title: hit.itmn,
      merchant: "Eureka",
      price: hit.clprc,
      currency: "KWD",
      // The store's canonical product route is /products/details/<id>; the
      // /en/<Title>/<id> variant hard-404s on the live host (REEA-136).
      url: `https://www.eureka.com.kw/products/details/${hit.objectID}`,
      inStock: typeof hit.avaqt === "number" ? hit.avaqt > 0 : true,
      ...(typeof hit.lprc === "number" && hit.lprc > hit.clprc ? { wasPrice: hit.lprc } : {}),
    });
  }
  return out;
}

export function sultanCenterHits(payload: unknown, query: string): SearchHit[] {
  const list =
    (payload as { products?: { product_list?: { name?: string; slug?: string; price?: string; spclprice?: string; is_in_stock?: string; currencysymbol?: string }[] } })
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
    if (titleMatchScore(title, query) < MIN_SCORE) continue;
    out.push({
      title,
      merchant: "Sultan Center",
      price,
      // Grocery prices on this storefront are quoted in KD (= KWD).
      currency: item.currencysymbol && item.currencysymbol !== "KD" ? item.currencysymbol : "KWD",
      url: `https://www.sultan-center.com/product/${slug}`,
      // Listed-with-price implies purchasable (same rule as extractInStock);
      // is_in_stock "0" is the explicit negative case.
      inStock: item.is_in_stock === undefined ? true : Number(item.is_in_stock) > 0,
      ...(promo ? { wasPrice: regular } : {}),
    });
  }
  return out;
}

export function jarirHits(payload: unknown, query: string): SearchHit[] {
  const results =
    (payload as { response?: { results?: { data?: { url?: string; price?: number | string; metadata?: { name?: string; price?: string } } }[] } })
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
    if (titleMatchScore(title, query) < MIN_SCORE) continue;
    out.push({
      title,
      merchant: "Jarir",
      price,
      // Constructor hits on jarir.com carry SAR; rendered as scraped (REEA-60 §7.1).
      currency: "SAR",
      url: `https://www.jarir.com/${slug}`,
      // Listed-with-price implies purchasable (same rule as extractInStock).
      inStock: true,
    });
  }
  return out;
}

/** amazon.eg `/s?k=` cards → hits (also exported for the single-best parser). */
export function amazonEgHits(html: string, query: string): SearchHit[] {
  const out: SearchHit[] = [];
  const wanted = new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 2),
  );
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
    if (wanted.size > 0) {
      const lower = title.toLowerCase();
      let matched = 0;
      for (const t of wanted) if (lower.includes(t)) matched++;
      if (matched / wanted.size < MIN_SCORE) continue;
    }
    out.push({
      title,
      merchant: "Amazon.eg",
      price,
      currency: "EGP",
      url: `https://www.amazon.eg/dp/${asin}`,
      inStock: !/غير متوفر|out of stock/i.test(seg),
    });
  }
  return out;
}

/* ---- Fetch orchestration, one collector per documented retailer endpoint. ---- */

const COLLECTORS: RetailerCollector[] = [
  {
    merchant: "Xcite",
    collect: async (query, fetchImpl) => {
      const res = await fetchChecked(
        fetchImpl,
        "https://www.xcite.com/api/algolia/proxy",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requests: [
              { indexName: "xcite_prod_kw_en_main", params: { query, hitsPerPage: 12 } },
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
    collect: async (query, fetchImpl) => {
      const res = await fetchChecked(
        fetchImpl,
        `https://blink.com.kw/products.json?title=${encodeURIComponent(query)}&limit=12`,
        { headers: { accept: "application/json" } },
        AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS),
      );
      return blinkHits(await res.json(), query);
    },
  },
  {
    merchant: "Eureka",
    collect: async (query, fetchImpl) => {
      const signal = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      const page = await fetchChecked(
        fetchImpl,
        "https://www.eureka.com.kw/",
        { headers: { accept: "text/html" } },
        signal,
      );
      const html = await page.text();
      const appId = html.match(/id="cky"[^>]*value="([^"]+)"/)?.[1];
      const searchKey = html.match(/id="srcapk"[^>]*value="([^"]+)"/)?.[1];
      if (!appId || !searchKey) throw new Error("eureka credentials missing");
      const res = await fetchChecked(
        fetchImpl,
        `https://${appId}-dsn.algolia.net/1/indexes/instant_records/query` +
          `?x-algolia-application-id=${appId}&x-algolia-api-key=${searchKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=12` }),
        },
        signal,
      );
      return eurekaHits(await res.json(), query);
    },
  },
  {
    merchant: "Sultan Center",
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
            pagesize: 12,
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
    collect: async (query, fetchImpl) => {
      const signal = AbortSignal.timeout(LIVE_SEARCH_TIMEOUT_MS * 2);
      const page = await fetchChecked(
        fetchImpl,
        "https://www.jarir.com/",
        { headers: { accept: "text/html" } },
        signal,
      );
      const indexKey = extractJarirIndexKey(await page.text());
      if (!indexKey) throw new Error("jarir index key missing");
      const res = await fetchChecked(
        fetchImpl,
        `https://ac.cnstrc.com/search/${encodeURIComponent(query)}` +
          `?key=${indexKey}&num_results_per_page=12`,
        { headers: { accept: "application/json" } },
        signal,
      );
      return jarirHits(await res.json(), query);
    },
  },
  {
    merchant: "Amazon.eg",
    collect: async (query, fetchImpl) => {
      // Amazon.eg intermittently serves an apology interstitial (HTTP 200, no
      // cards) that resolves on re-fetch — two bounded attempts (REEA-93).
      let hits: SearchHit[] = [];
      for (let attempt = 0; attempt < 2 && hits.length === 0; attempt++) {
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
      }
      return hits;
    },
  },
];

/**
 * Group raw retailer hits into one product per distinct title. Exact
 * normalized-title matching merges the same item across retailers (one card,
 * one offer per retailer — cheapest first). Titles are kept verbatim from the
 * retailer hit that scored highest against the query.
 */
export function groupHits(query: string, hits: SearchHit[]): NormalizedProduct[] {
  const groups = new Map<string, { title: string; titleScore: number; offers: SearchHit[] }>();
  for (const hit of hits) {
    const key = hit.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key) continue;
    const score = titleMatchScore(hit.title, query);
    let group = groups.get(key);
    if (!group) {
      group = { title: hit.title, titleScore: score, offers: [] };
      groups.set(key, group);
    } else if (score > group.titleScore) {
      // Keep the title form that best matches the query.
      group.title = hit.title;
      group.titleScore = score;
    }
    if (!group.offers.some((o) => o.merchant === hit.merchant)) group.offers.push(hit);
  }

  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.titleScore - a.titleScore ||
      Math.min(...a.offers.map((o) => o.price)) - Math.min(...b.offers.map((o) => o.price)),
  );
  const selected = sorted.slice(0, LIVE_SEARCH_MAX_PRODUCTS);
  const scrapedAt = new Date().toISOString(); // real collection completion time

  return selected.map((group, idx) => {
    const offers: PriceOffer[] = [...group.offers]
      .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.price - b.price)
      .map((o) => ({
        merchant: o.merchant,
        price: o.price,
        currency: o.currency,
        url: o.url,
        inStock: o.inStock,
        ...(o.wasPrice != null ? { wasPrice: o.wasPrice } : {}),
      }));
    return {
      productId: slugify(group.title) || `live-${idx}`,
      title: group.title,
      brand: brandOf(group.title),
      offers,
      coupons: [],
      variations: [],
      alternatives: selected
        .filter((other) => other !== group)
        .slice(0, 3)
        .map((other) => ({
          productId: slugify(other.title),
          title: other.title,
          fromPrice: Math.min(...other.offers.map((o) => o.price)),
        })),
      scrapedAt,
    } satisfies NormalizedProduct;
  });
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function brandOf(title: string): string {
  // First token of the scraped title is a good enough brand chip.
  return title.trim().split(/\s+/)[0] ?? title;
}

export interface LiveSearchResult {
  products: NormalizedProduct[];
  /** Per-retailer notes for the diagnostics panel; failures included. */
  notes: { merchant: string; hits: number; error?: string }[];
}

/**
 * Collect live results for a query at request time. One bounded call per
 * retailer, run in parallel; a slow or failed retailer only loses its own
 * offers. Returns products ranked by title relevance, cheapest first inside
 * each group. Never reads seed files or caches — every call re-collects.
 */
export async function collectLiveResults(
  query: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<LiveSearchResult> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const q = query.trim();
  const settled = await Promise.all(
    COLLECTORS.map(async (c): Promise<{ merchant: string; hits: SearchHit[]; error?: string }> => {
      try {
        return { merchant: c.merchant, hits: await c.collect(q, fetchImpl) };
      } catch (err) {
        return {
          merchant: c.merchant,
          hits: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const hits: SearchHit[] = [];
  const notes: LiveSearchResult["notes"] = [];
  for (const s of settled) {
    hits.push(...s.hits);
    notes.push({ merchant: s.merchant, hits: s.hits.length, ...(s.error ? { error: s.error } : {}) });
  }
  return { products: groupHits(q, hits), notes };
}
