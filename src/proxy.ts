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

export function sharedWindowHeaders(): { "Cache-Control": string; Vary: string } {
  return {
    "Cache-Control": "public, max-age=0, s-maxage=45, stale-while-revalidate=15",
    // Carries Accept-Language first (locale must not share entries) plus the
    // framework's own vary terms so the combined list survives wherever the
    // renderer does not rewrite Vary itself.
    Vary: "Accept-Language, rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding",
  };
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);
  const enforce = CSP_MODE === "enforce";
  const cspHeader = enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

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
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY"); // legacy complement to frame-ancestors
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // REEA-439 — bounded shared window + locale Vary ride together on both
  // results addresses (sharedWindowHeaders above); middleware-set headers
  // merge with the framework's own list instead of being overwritten.
  const path = request.nextUrl.pathname;
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
