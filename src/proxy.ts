/**
 * F2 remediation — CSP + hardening headers (REEA-13).
 *
 * Next 16 file convention: `src/proxy.ts` (the renamed middleware entrypoint;
 * the exported function is `proxy`). Rollout: default CSP_MODE=enforce;
 * "report-only" is available for staged monitoring. CSP is defense-in-depth
 * for F1, not a substitute for URL validation.
 *
 * Security lenses: Secure Defaults, Fail Securely, Minimize Attack Surface.
 */
import { NextResponse, type NextRequest } from "next/server";

const CSP_MODE = (process.env.CSP_MODE ?? "enforce").toLowerCase(); // "enforce" | "report-only"

export function buildCsp(nonce: string, mode: string = CSP_MODE): string {
  // REEA-1088: the REEA-82 "every page is prerendered" premise no longer holds
  // — the root layout reads cookies/headers (resolveRequestLocale) and
  // /results, /search and /product/[productId] are force-dynamic, so Next
  // renders per request and injects the per-request nonce into its bootstrap
  // and inline scripts (docs: content-security-policy guide). `'strict-dynamic'`
  // is needed for the chunks those trusted scripts load themselves; browsers
  // then ignore the `'self'` host-source for scripts, so every script must be
  // nonce-trusted. `style-src` stays on `'unsafe-inline'` because the theme
  // renders inline style attributes, which cannot carry a nonce. No inline
  // event handlers or `javascript:` URLs remain in the app: React attaches
  // listeners through JS and outbound URLs go through safe-url/offer-schema.
  // Dev only: React's enhanced debug stack reconstruction uses eval.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ];
  // Stage 1 keeps violation reporting in enforce mode so the sink at
  // /api/csp-report (REEA-74) feeds the Stage-2 monitoring window.
  const policy = `${directives.join("; ")}; report-uri /api/csp-report`;
  return policy;
}

/**
 * REEA-439 — bounded shared window for repeat identical searches, moved here
 * from the next.config headers block so BOTH results-address response headers
 * (the window plus its locale Vary) are set together in middleware: the
 * renderer overwrites plain framework headers, so the pair belongs in one
 * place. The window keys on the URL — the query string IS the normalized
 * search — so each locale variant of a query keeps its own bounded entry
 * ("normalized query, keep locale"), and Refresh bypasses with a unique
 * `?_r=` stamp (see src/lib/query-cache.ts).
 */
export const RESULTS_PATHS = ["/results", "/search"] as const;

/**
 * REEA-1133 — page-level per-IP budget for the addresses that run the live
 * retailer fan-out (F1/REEA-1121). REEA-1121 measured 20 parallel distinct
 * /results?q= renders on the live box answering 20×200 with zero 429s; every
 * one of them fans out ~15 retailer lanes. This gate is the first line of
 * defence and it is deliberately cheap: a sliding window over request
 * timestamps, no I/O.
 *
 * Semantics, stated honestly:
 *  - per PROCESS, exactly like the REEA-37 ingestion limiter: the self-hosted
 *    box runs one Next server process today, so this is a real per-IP budget
 *    there; a future multi-worker deployment would enforce it per worker
 *    (the admission cap in lib/collect/inflight.ts remains the fleet-wide
 *    bound on actual fan-out).
 *  - the key is the client IP taken from the trusted proxy hop, never stored
 *    or logged (no PII leaves the process).
 *  - 60 requests/minute covers a shopper paging through results (each page
 *    view is one document GET) with generous headroom; a crawler or a scripted
 *    burst hits it immediately and gets a 429 with Retry-After instead of a
 *    fresh fan-out.
 *  - prefetch/RSC requests are counted too: they still render the page on the
 *    server and can still start a fan-out.
 */
export const PAGE_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

const pageBuckets = new Map<string, number[]>();

/** Test helper: clear the page bucket store. */
export function resetPageRateLimiter(): void {
  pageBuckets.clear();
}

/** True for the page addresses whose render runs the live retailer fan-out. */
export function isLiveFanoutPage(pathname: string): boolean {
  return (
    (RESULTS_PATHS as readonly string[]).includes(pathname) ||
    pathname === "/product" ||
    pathname.startsWith("/product/")
  );
}

/**
 * The client address behind our own reverse proxy. Caddy APPENDS the peer
 * address to any client-supplied X-Forwarded-For, so the LAST entry is the one
 * our edge observed — the first entry is client-controlled and spoofable. A
 * direct (loopback) request has no forwarding headers and keys as "unknown",
 * which is the conservative shared-bucket choice.
 */
export function clientAddressOf(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp || "unknown";
}

/**
 * Sliding-window per-IP gate for the live fan-out pages. Mirrors the REEA-37
 * limiter's semantics (bounded memory, oldest-hit expiry) but keeps its OWN
 * store: proxy code runs in its own module instance and must not depend on
 * state shared with render code.
 */
export function checkPageRateLimit(
  key: string,
  now: number,
  opts: { limit: number; windowMs: number } = PAGE_RATE_LIMIT,
  store: Map<string, number[]> = pageBuckets,
): { allowed: boolean; remaining: number; retryAfterMs?: number } {
  const hits = (store.get(key) ?? []).filter((t) => now - t < opts.windowMs);
  if (hits.length >= opts.limit) {
    store.set(key, hits);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, hits[0] + opts.windowMs - now) };
  }
  hits.push(now);
  store.set(key, hits);
  if (store.size > 10_000) {
    for (const [k, v] of store) {
      if (v.every((t) => now - t >= opts.windowMs)) store.delete(k);
    }
  }
  return { allowed: true, remaining: opts.limit - hits.length };
}

/**
 * REEA-1269 — /sitemap.xml is a crawler artifact, not a shopper page: the
 * folded catalogue changes on the scale of minutes and the render is
 * `force-dynamic` (REEA-1051), so Next's default `max-age=0, must-revalidate`
 * made every crawl re-pay the fold. A bounded shared-cache window keeps the
 * route cacheable (S-6) without serving an hour-stale inventory; the in-process
 * fold memo (lib/sitemap-products) already bounds the origin cost inside it.
 */
export function sitemapCacheHeaders(): { "Cache-Control": string } {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=3600" };
}

export function sharedWindowHeaders(): { "Cache-Control": string; Vary: string } {
  return {
    "Cache-Control": "public, max-age=0, s-maxage=45, stale-while-revalidate=15",
    // Carries Accept-Language first (locale must not share entries) plus the
    // framework's own vary terms so the combined list survives wherever the
    // renderer does not rewrite Vary itself.
    Vary: "Accept-Language, rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding",
  };
}

/** Shared hardening headers for every response this proxy returns. */
function hardeningHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY", // legacy complement to frame-ancestors
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);
  const enforce = CSP_MODE === "enforce";
  const cspHeader = enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
  const path = request.nextUrl.pathname;
  let pageBudget: { limit: number; remaining: number } | null = null;

  // REEA-1133 — per-IP page gate BEFORE any render work. A 429 here means the
  // request never starts a fan-out; Retry-After tells the crawler/script when
  // the window frees. The response still carries the hardening CSP.
  if (isLiveFanoutPage(path)) {
    const gate = checkPageRateLimit(clientAddressOf(request), Date.now());
    if (!gate.allowed) {
      const limited = new NextResponse("Too many requests — please retry shortly.", {
        status: 429,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": String(Math.max(1, Math.ceil((gate.retryAfterMs ?? PAGE_RATE_LIMIT.windowMs) / 1000))),
          "X-RateLimit-Limit": String(PAGE_RATE_LIMIT.limit),
          "X-RateLimit-Remaining": "0",
          ...hardeningHeaders(),
        },
      });
      limited.headers.set(cspHeader, csp);
      return limited;
    }
    pageBudget = { limit: PAGE_RATE_LIMIT.limit, remaining: gate.remaining };
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // REEA-1088 — nonce propagation. Next extracts the nonce from the REQUEST's
  // CSP header (getScriptNonceFromHeaders in the app-render path, matching the
  // documented proxy pattern) and then stamps its bootstrap/inline scripts
  // with it. `x-nonce` alone is not read by the framework — it is the channel
  // for app code that renders its own <Script> tags (there are none today).
  // Without this request-header copy the response policy would carry a nonce
  // that no script tag has, and `'strict-dynamic'` would block every script:
  // exactly the REEA-82 blank-results failure mode.
  requestHeaders.set(cspHeader, csp);
  // REEA-447 R2 — forward the segment query text to the render so the shell
  // locale chain (cookie → Accept-Language hint → Arabic-script query) can
  // run in the layout on the INITIAL document GET, where Next's own
  // `next-url` header is absent. Percent-encoded so the header value stays
  // ASCII-clean across the edge hop; src/lib/i18n-server.ts decodes it back
  // and feeds resolveUiLocale — cookie/header preferences still win the chain.
  const queryHint = request.nextUrl.searchParams.get("q");
  if (queryHint) {
    requestHeaders.set("x-query-text", encodeURIComponent(queryHint));
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(cspHeader, csp);
  for (const [key, value] of Object.entries(hardeningHeaders())) {
    response.headers.set(key, value);
  }
  if (pageBudget) {
    response.headers.set("X-RateLimit-Limit", String(pageBudget.limit));
    response.headers.set("X-RateLimit-Remaining", String(pageBudget.remaining));
  }
  // REEA-439 — bounded shared window + locale Vary ride together on both
  // results addresses (sharedWindowHeaders above); middleware-set headers
  // merge with the framework's own list instead of being overwritten.
  if (RESULTS_PATHS.some((source) => path === source)) {
    for (const [key, value] of Object.entries(sharedWindowHeaders())) {
      response.headers.set(key, value);
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
