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

/** Extract a unit price from JSON-LD blocks, then meta tags. */
export function extractPrice(html: string): number | null {
  // JSON-LD: "price": 12.34 (offers schema.org/Offer or Product.offers)
  const jsonLd = html.match(/"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)"?/i);
  if (jsonLd) {
    const v = Number.parseFloat(jsonLd[1].replace(",", "."));
    if (Number.isFinite(v) && v > 0) return v;
  }
  const meta =
    html.match(
      /<meta[^>]+property=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([0-9]+(?:\.[0-9]{1,2})?)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([0-9]+(?:\.[0-9]{1,2})?)["'][^>]+property=["'](?:product:price:amount|og:price:amount)["']/i,
    );
  if (meta) {
    const v = Number.parseFloat(meta[1]);
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
    return await res.text();
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
  const timeoutMs = opts.timeoutMs ?? PER_RETAILER_TIMEOUT_MS;
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const domain = domainOf(offer.url);
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
  const price = extractPrice(html);
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
