/**
 * REEA-1128 — retailer image delivery policy.
 *
 * QA reproduced broken results-page thumbnails on the live box: cards whose
 * `image` points at `cdn.shopify.com` intermittently answered HTTP 403 to the
 * BROWSER's own hotlink fetch, which left an empty media frame and a
 * "Failed to load resource: 403" console error (the REEA-1118 guardrail).
 *
 * What the evidence actually shows (probed against the live stamp `eba496c`,
 * `/results?q=headphones`, real Chromium):
 *  - The 403 is NOT a referrer rule. The same URL answers 403 with no
 *    `Referer`, with the site origin as `Referer`, and with a browser UA; it
 *    answers 200 a minute later with the exact same headers. `referrerPolicy`
 *    alone therefore cannot fix it (we still set it — see CardMedia — because
 *    the retailer CDNs should not see our origin, but it is not the cure).
 *  - It is an upstream cold-cache failure in Shopify's imagery service: the
 *    first fetch of a product image (cache MISS) is refused while the origin
 *    copy is being pulled, and the same URL serves 200 once warm. That is why
 *    it looked "intermittent" per page load.
 *  - A server-side fetch of the same URL answers 200 (plain sequential
 *    requests warm the entry), so the shopper's browser does not have to be
 *    the one that eats the cold miss.
 *
 * The fix is therefore to stop pointing the browser at the third-party CDN for
 * the hosts that refuse hotlink fetches: the card renders a SAME-ORIGIN
 * `/api/image?u=…` URL, our box fetches it (retry + in-process cache), and the
 * route always answers 200 — the image when it resolves, a neutral category
 * glyph when it does not — so no browser console error and no broken-image
 * placeholder can reach the shopper. See src/app/api/image/route.ts.
 *
 * Only the hosts with the measured cold-miss behaviour are proxied; every
 * other retailer image keeps its direct URL so this change cannot slow down
 * the CDNs that already answer correctly.
 */

/** Same-origin route that fronts the proxied hosts (see the route handler). */
export const IMAGE_PROXY_ROUTE = "/api/image";

/**
 * Hosts whose browser-side hotlink fetch is unreliable (REEA-1128 evidence).
 * Suffix match so a future store-specific Shopify CDN hostname
 * (`<shop>.cdn.shopify.com`) is covered by the same policy.
 */
const PROXIED_HOST_SUFFIXES = ["cdn.shopify.com", "shopifycdn.com"] as const;

/** The UA our box presents to the CDN. A plain `fetch` default is refused by
 *  some retailer edges; this is the same identity the adapters already use. */
export const IMAGE_PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** True when `src` is an https URL on a host that must be proxied. */
export function shouldProxyImage(src: string | null | undefined): boolean {
  const value = src?.trim();
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return PROXIED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * The URL the media frame should actually render: the same-origin proxy for
 * the proxied hosts, the untouched original for every other retailer image.
 * Returns `undefined` for a blank/absent source so the caller can fall back to
 * the category glyph exactly as before.
 */
export function proxiedImageSrc(src: string | null | undefined): string | undefined {
  const value = src?.trim();
  if (!value) return undefined;
  if (!shouldProxyImage(value)) return value;
  return `${IMAGE_PROXY_ROUTE}?u=${encodeURIComponent(value)}`;
}

/**
 * True when a media `src` is already the same-origin proxy URL this module
 * built. Call sites use it to choose the retrying <img> (ProxyRetryImage) for
 * proxied sources while every other retailer image keeps next/image exactly as
 * before.
 */
export function isProxiedImageSrc(src: string | null | undefined): boolean {
  return typeof src === "string" && src.startsWith(`${IMAGE_PROXY_ROUTE}?`);
}

/**
 * SSRF guard for the proxy route: only absolute https URLs, only hostnames
 * that resolve on the public internet. `u` is rendered by us, but it is a
 * public query parameter — anyone can make the box fetch a URL, so it must not
 * be able to reach the loopback, the container network or cloud metadata.
 *
 * IP literals are checked directly; hostnames are checked by shape (single
 * label names like `localhost`/`intranet` and `.local`/`.internal` suffixes are
 * refused). A public hostname that resolves to a private address is not
 * re-resolved here — the payload is an image, so shape-level refusal plus the
 * byte cap is the proportionate guard.
 */
export function isFetchableImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;

  if (isIpLiteral(host)) return !isPrivateIp(host);

  if (!host.includes(".")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  return true;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isPrivateIp(host: string): boolean {
  // IPv6 loopback / unique-local / link-local.
  if (host.includes(":")) {
    const h = host.toLowerCase();
    return (
      h === "::1" ||
      h === "::" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe8") ||
      h.startsWith("fe9") ||
      h.startsWith("fea") ||
      h.startsWith("feb")
    );
  }
  const parts = host.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
