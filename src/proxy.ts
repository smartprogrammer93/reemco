/**
 * F2 remediation — CSP + hardening headers (REEA-13).
 *
 * Place at repo root as `middleware.ts` (or `src/middleware.ts`).
 * Rollout: default CSP_MODE=report-only; flip env to "enforce" after
 * report monitoring shows no violations. CSP is defense-in-depth for F1,
 * not a substitute for URL validation.
 *
 * Security lenses: Secure Defaults, Fail Securely, Minimize Attack Surface.
 */
import { NextResponse, type NextRequest } from "next/server";

const CSP_MODE = (process.env.CSP_MODE ?? "enforce").toLowerCase(); // "enforce" | "report-only"

export function buildCsp(nonce: string, mode: string = CSP_MODE): string {
  const directives = [
    `default-src 'self'`,
    // REEA-82: every page is statically prerendered, so Next.js cannot inject
    // per-request nonces into its bootstrap scripts (nonces only work on
    // dynamically rendered pages), and `'strict-dynamic'` makes browsers
    // ignore the `'self'` host source. The previous nonce policy therefore
    // blocked every script and hydration never ran — /results stayed on the
    // loading skeletons forever. Ship the policy the static bundles actually
    // satisfy (same as the layout's static-host meta fallback) until pages
    // move to dynamic rendering with full nonce propagation.
    `script-src 'self' 'unsafe-inline'`,
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

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", csp);
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
