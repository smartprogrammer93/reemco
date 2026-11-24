/**
 * REEA-1128 — same-origin retailer image proxy.
 *
 * `GET /api/image?u=<encodeURIComponent(absolute https url)>`
 *
 * Why this exists: QA's results-page repro showed `cdn.shopify.com` answering
 * HTTP 403 to the BROWSER's hotlink fetch, so cards rendered an empty frame
 * plus a `Failed to load resource: 403` console error. The same URL answers
 * 200 to a plain server-side fetch (and 200 to any client once Shopify's
 * imagery cache is warm), so the shopper's browser should not be the one that
 * eats the cold miss. Policy and the full evidence trail live in
 * src/lib/image-proxy.ts; this route is the server half.
 *
 * Contract (the REEA-1118 guardrail — "no console errors on the results page"):
 *  - ALWAYS answers 200. A shopper never sees a broken-image icon, and Chrome
 *    never logs a failed resource. When the upstream refuses, the body is a
 *    neutral category glyph in the design's own visual language instead of a
 *    transparent hole, and the short cache TTL makes the next page load retry.
 *  - Success bodies are cached in-process (bounded LRU) with single-flight
 *    de-duplication, so one cold miss warms the URL for every following
 *    shopper on this instance and a burst of cards cannot fan out a burst of
 *    upstream fetches for the same image.
 *  - The browser gets a long-lived `Cache-Control`, so repeat visits never
 *    touch this route at all.
 *  - `u` is a public query parameter, so the upstream is restricted to public
 *    https image URLs (SSRF guard in isFetchableImageUrl) and the body is
 *    capped; a non-image content-type is treated as a miss.
 */

import type { NextRequest } from "next/server";
import {
  IMAGE_PROXY_USER_AGENT,
  isFetchableImageUrl,
} from "@/lib/image-proxy";

export const runtime = "nodejs";
// Query-string driven, per-request upstream fetch: never statically cached by
// the framework (the route keeps its own bounded cache below).
export const dynamic = "force-dynamic";

/** Per-attempt upstream budget. A retailer image hop that has not answered in
 *  this window is a miss, not something to make the shopper wait for. */
const UPSTREAM_TIMEOUT_MS = 4000;
/** Overall budget for one shopper's image request. The card frame reserves its
 *  geometry, so a miss never shifts layout — but the frame must not stay blank
 *  for long either: past this deadline the request degrades to the glyph. */
const UPSTREAM_BUDGET_MS = 6000;
/** Hard body cap — a product image far above this is a broken upstream answer,
 *  not a thumbnail. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** Bounded in-process cache. The results page renders ~10 thumbnails per
 *  query; 256 entries covers the hot set of a small instance without letting a
 *  long tail of distinct products grow the heap unbounded. */
const CACHE_MAX_ENTRIES = 256;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
/** Backoff between attempts. Shopify's cold imagery miss clears on a warm
 *  entry, so the retry is short and sequential rather than a fan-out; three
 *  attempts cost ~0.75 s of sleep on a host that refuses instantly. */
const RETRY_DELAYS_MS = [150, 600] as const;
/** Placeholder freshness: short, so the very next page load re-attempts the
 *  upstream instead of pinning a miss for a day. */
const PLACEHOLDER_MAX_AGE_S = 30;
/** Successful image freshness: a product image URL carries the retailer's own
 *  version stamp (`?v=…`), so a changed photo is a changed URL. */
const IMAGE_MAX_AGE_S = 31_536_000;

type CachedImage = { body: Buffer; type: string; at: number };

const cache = new Map<string, CachedImage>();
let cacheBytes = 0;

function cacheGet(key: string): CachedImage | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(key: string, value: Omit<CachedImage, "at">): void {
  const entry: CachedImage = { ...value, at: Date.now() };
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.body.length;
  cache.set(key, entry);
  cacheBytes += entry.body.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = cache.get(oldest);
    cache.delete(oldest);
    if (dropped) cacheBytes -= dropped.body.length;
  }
}

/** One in-flight upstream fetch per URL: a page with several cards sharing a
 *  photo (or a shopper double-rendering the grid) issues ONE upstream hop. */
const inFlight = new Map<string, Promise<{ body: Buffer; type: string } | null>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUpstreamOnce(
  url: string,
  timeoutMs: number,
): Promise<{ body: Buffer; type: string } | null> {
  const res = await fetch(url, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": IMAGE_PROXY_USER_AGENT,
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  if (res.status !== 200) {
    // Drain the connection so the socket is released.
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0 || body.length > MAX_IMAGE_BYTES) return null;
  return { body, type };
}

/**
 * The upstream hop with the REEA-1128 retry: the measured failure is a
 * transient 403 on a cold Shopify imagery entry, so attempts are sequential
 * with backoff, all inside ONE bounded budget. A host that hangs cannot hold
 * the shopper's frame past UPSTREAM_BUDGET_MS — the request degrades to the
 * glyph and the short placeholder TTL retries on the next page load.
 */
async function fetchUpstream(url: string): Promise<{ body: Buffer; type: string } | null> {
  const deadline = Date.now() + UPSTREAM_BUDGET_MS;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const hit = await fetchUpstreamOnce(url, Math.min(UPSTREAM_TIMEOUT_MS, remaining));
      if (hit) return hit;
    } catch {
      // Timeout / network reset: fall through to the retry schedule.
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined && Date.now() + delay < deadline) await sleep(delay);
  }
  return null;
}

function loadImage(url: string): Promise<{ body: Buffer; type: string } | null> {
  const cached = cacheGet(url);
  if (cached) return Promise.resolve({ body: cached.body, type: cached.type });
  const pending = inFlight.get(url);
  if (pending) return pending;
  const started = fetchUpstream(url)
    .then((hit) => {
      if (hit) cachePut(url, hit);
      return hit;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(url);
    });
  inFlight.set(url, started);
  return started;
}

/**
 * The neutral miss body: the design's own category glyph (ProductResultCard's
 * CategoryGlyph path), drawn at the card frame's 160px recognition scale in
 * the muted token value. It is an SVG because the frame cannot know from CSS
 * that the image failed; this keeps a miss reading as "no photo for this
 * product" (the same language as an image-less feed card) instead of a
 * broken-image icon or an empty box. `prefers-color-scheme` picks the dark
 * token value where the image document honours it; the base grey is legible on
 * both surfaces.
 */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="product image unavailable">
<style>.g{stroke:#8F8375}@media (prefers-color-scheme:dark){.g{stroke:#A79783}}</style>
<g class="g" fill="none" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(2.667)">
<path d="M3 9.5 5.5 4h13L21 9.5V20H3V9.5Z"/><path d="M3 9.5h18M8.5 13.5h7"/>
</g>
</svg>`;

function placeholderResponse(): Response {
  return new Response(PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${PLACEHOLDER_MAX_AGE_S}`,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const raw = req.nextUrl.searchParams.get("u") ?? "";
  // An absent/invalid `u` is a programming error, but it still must not log a
  // console error on the shopper's page: answer the neutral glyph.
  if (!raw || !isFetchableImageUrl(raw)) return placeholderResponse();

  const hit = await loadImage(raw);
  if (!hit) return placeholderResponse();

  return new Response(new Uint8Array(hit.body), {
    status: 200,
    headers: {
      "content-type": hit.type,
      "content-length": String(hit.body.length),
      "cache-control": `public, max-age=${IMAGE_MAX_AGE_S}, immutable`,
      "x-content-type-options": "nosniff",
    },
  });
}
