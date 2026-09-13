/**
 * REEA-84 W1 — per-retailer scrape adapters (T2).
 *
 * One adapter invocation per retailer offer URL: fetch the live product page
 * with a hard timeout, extract structured price data (JSON-LD, then meta
 * tags), and return a LiveOffer with provenance. No raw HTML is persisted —
 * the page body is discarded after parsing (AC9).
 *
 * Real retailer pages vary widely; any parse failure surfaces as a per-retailer
 * `failed` subtask (AC6) rather than a product-level error, and the fetch is
 * injectable for deterministic tests.
 */
import type { LiveOffer, RetailerSubtask } from "@/lib/collect/types";
import { PER_RETAILER_TIMEOUT_MS } from "@/lib/collect/types";
import { searchRetailerFallback } from "@/lib/collect/search-fallback";
import { readBodyCapped } from "@/lib/collect/read-body";

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Injectable fetch for tests — string URLs only (we never pass a Request). */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ScrapeOutcome {
  offers: LiveOffer[];
  error?: string;
  timedOut?: boolean;
}

/**
 * Open Graph product price meta tags: the platform's own formatted major-unit
 * value. Shopify stamps og:price:amount from the PDP URL's canonical variant,
 * so it matches the search-path price for that exact product (measured live
 * 2026-09-13: zayoom "379.90", blink "369.00", astore "408.00", quadra
 * "257.90", switch "9.9", wibi "409.9" — every one equal to the suggest.json
 * price the /search adapters render). Decimal allowance is 1–3: KWD is a
 * three-decimal currency and some storefronts stamp "379.900".
 */
const META_PRICE_RES = [
  /<meta[^>]+property=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([0-9]+(?:\.[0-9]{1,3})?)["']/i,
  /<meta[^>]+content=["']([0-9]+(?:\.[0-9]{1,3})?)["'][^>]+property=["'](?:product:price:amount|og:price:amount)["']/i,
];

/** Currency meta guard: reject a meta price stamped in another currency. */
function metaPriceCurrencyOf(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["'](?:product:price:currency|og:price:currency)["'][^>]+content=["']([A-Za-z]{3})["']/i) ??
    html.match(/<meta[^>]+content=["']([A-Za-z]{3})["'][^>]+property=["'](?:product:price:currency|og:price:currency)["']/i);
  return m ? m[1].toUpperCase() : null;
}

/** "KD" is the local spelling of KWD (same rule the card scanners use). */
function sameCurrency(a: string, b: string): boolean {
  const norm = (c: string) => {
    const u = c.trim().toUpperCase();
    return u === "KD" ? "KWD" : u;
  };
  return norm(a) === norm(b);
}

/**
 * REEA-896 — read a price out of REAL application/ld+json blocks only,
 * parsed as JSON. The pre-896 "JSON-LD" step was an unscoped regex over the
 * whole document, so on Shopify PDPs it matched the theme's inline variant
 * array first — `"price":37990`, minor units the theme ships alongside the
 * real schema.org record — and the product-page collection rendered
 * fils-scale integers as KD (Zayoom 379.900 → KD 37,990; the same class on
 * blink/astore/quadra/switch/wibi PDPs). Walks Product/Offer/AggregateOffer
 * nodes; when the retailer's expected currency is known, a declared
 * priceCurrency must agree, so a cross-currency record can never be taken as
 * the page price.
 */
function jsonLdOfferPrice(node: unknown, expectedCurrency: string | undefined): number | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const v = jsonLdOfferPrice(child, expectedCurrency);
      if (v != null) return v;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  const type = typeof record["@type"] === "string" ? record["@type"] : "";
  const rawPrice = record.price;
  if (rawPrice != null && /(?:^|\b)(?:Offer|Product|AggregateOffer)(?:\b|$)/.test(type)) {
    const cur = typeof record.priceCurrency === "string" ? record.priceCurrency : undefined;
    const currencyOk =
      expectedCurrency == null || cur == null || sameCurrency(cur, expectedCurrency);
    const value =
      typeof rawPrice === "number"
        ? rawPrice
        : typeof rawPrice === "string"
          ? Number.parseFloat(rawPrice.replace(/,/g, "").trim())
          : NaN;
    if (currencyOk && Number.isFinite(value) && value > 0) return value;
  }
  for (const child of Object.values(record)) {
    const v = jsonLdOfferPrice(child, expectedCurrency);
    if (v != null) return v;
  }
  return null;
}

/**
 * Extract a unit price from a retailer PDP, most trustworthy signal first
 * (REEA-896): product:price:amount / og:price:amount meta (the platform's
 * canonical major-unit value for this URL, rejected when its own currency
 * meta disagrees with the retailer's), then real application/ld+json
 * Product/Offer blocks, then the legacy whole-document first-"price" scan —
 * pages with neither structured signal keep the exact pre-REEA-896 behavior.
 * `expectedCurrency` (the seed offer's currency) guards the structured reads
 * against cross-currency records; the legacy scan is unchanged and unguarded,
 * exactly as before.
 */
export function extractPrice(html: string, expectedCurrency?: string): number | null {
  const metaCur = metaPriceCurrencyOf(html);
  for (const re of META_PRICE_RES) {
    const m = html.match(re);
    if (m) {
      const v = Number.parseFloat(m[1]);
      const currencyOk = metaCur == null || expectedCurrency == null || sameCurrency(metaCur, expectedCurrency);
      if (currencyOk && Number.isFinite(v) && v > 0) return v;
    }
  }
  for (const block of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue; // malformed record — try the next block
    }
    const v = jsonLdOfferPrice(parsed, expectedCurrency);
    if (v != null) return v;
  }
  // Legacy scan (pre-REEA-896 behavior, last resort): "price": 12.34 anywhere.
  const jsonLd = html.match(/"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)"?/i);
  if (jsonLd) {
    const v = Number.parseFloat(jsonLd[1].replace(",", "."));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export function extractInStock(html: string): boolean {
  if (/availability[^>]*(instock|in_stock|limitedavailability)/i.test(html)) return true;
  if (/availability[^>]*outofstock/i.test(html)) return false;
  return true; // unknown — assume listed means purchasable
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "ReemcoBot/1.0 (+https://reemco.vercel.app; price comparison)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // REEA-376: bounded read — an oversized upstream document aborts with an
    // error note instead of buffering whole into the scrape budget.
    return await readBodyCapped(res);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Soft-not-found detection (REEA-115). xcite answers stale/guessed slugs with
 * HTTP 200 plus a branded shell whose document title is "404: Page Not Found …",
 * so a status-code check alone is not enough: treat that title as a miss and let
 * the search fallback re-discover the live product URL by title.
 */
export function isSoftNotFound(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]+?)\s*<\/title>/i)?.[1] ?? "";
  return /^(?:404\b|page not found\b)/i.test(title.trim());
}

/**
 * Scrape one retailer offer URL. Enforces the per-retailer timeout server-side
 * (AC7); a timeout is reported distinctly so the UI can show "timed out".
 */
export async function scrapeOffer(
  offer: { merchant: string; url: string; currency: string; wasPrice?: number; titleQuery?: string },
  opts: { timeoutMs?: number; fetchImpl?: FetchImpl; now?: number } = {},
): Promise<ScrapeOutcome> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const domain = domainOf(offer.url);
  // REEA-866 — the REEA-264 lane-aware default (SC hosts ~2 s, everyone else
  // the shared budget) is retired: the completion-budget staged render no
  // longer lets a slow lane gate anything, while the 2 s cap aborted most
  // live SC rounds (W37: 4 offers served). Every lane keeps the shared
  // per-retailer budget; an explicitly injected opts.timeoutMs still wins.
  const timeoutMs = opts.timeoutMs ?? PER_RETAILER_TIMEOUT_MS;
  const direct = await tryDirectFetch(offer, { timeoutMs, fetchImpl, now: opts.now, domain });
  if (direct) return direct;
  // Fallback: re-discover the product via the retailer's own search API —
  // seeded catalog URLs go stale (REEA-67) and some PDPs are client-rendered.
  try {
    const found = await searchRetailerFallback(domain, offer.titleQuery ?? "", fetchImpl);
    return {
      offers: [
        {
          merchant: offer.merchant,
          domain,
          price: found.price,
          currency: found.currency,
          url: found.url,
          inStock: found.inStock,
          ...(found.wasPrice != null ? { wasPrice: found.wasPrice } : {}),
          collectedAt: new Date(opts.now ?? Date.now()).toISOString(),
          method: "live",
        },
      ],
    };
  } catch (err) {
    return {
      offers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function tryDirectFetch(
  offer: { merchant: string; url: string; currency: string; wasPrice?: number; titleQuery?: string },
  opts: { timeoutMs: number; fetchImpl: FetchImpl; now?: number; domain: string },
): Promise<{ offers: LiveOffer[]; error?: string; timedOut?: boolean } | null> {
  let html: string;
  try {
    html = await fetchWithTimeout(offer.url, opts.timeoutMs, opts.fetchImpl);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (aborted) {
      // Hard timeout — do not spend the budget on a fallback search.
      return {
        offers: [],
        timedOut: true,
        error: `Timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
      };
    }
    return null; // transient HTTP/network error — caller tries search fallback
  }
  if (isSoftNotFound(html)) return null; // branded soft-404 shell — re-discover via search
  // REEA-896: the seed offer's currency guards the structured reads (meta +
  // JSON-LD) against cross-currency records on the same page.
  const price = extractPrice(html, offer.currency);
  if (price == null) return null; // unparseable/client-rendered — try fallback
  return {
    offers: [
      {
        merchant: offer.merchant,
        domain: opts.domain,
        price,
        currency: offer.currency,
        url: offer.url,
        inStock: extractInStock(html),
        wasPrice: offer.wasPrice,
        collectedAt: new Date(opts.now ?? Date.now()).toISOString(),
        method: "live",
      },
    ],
  };
}

/** Build the initial subtask row for an offer's retailer. */
export function subtaskFor(offer: {
  merchant: string;
  url: string;
}): RetailerSubtask {
  return {
    retailer: offer.merchant,
    domain: domainOf(offer.url),
    status: "pending",
    offersFound: 0,
  };
}
