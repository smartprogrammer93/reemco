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

/** REEA-439 shared repeat-search window: 45 s fresh + 15 s SWR tail (≤ 60 s). */
export const RESULTS_CACHE_CONTROL =
  "public, max-age=0, s-maxage=45, stale-while-revalidate=15";

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
  // REEA-439 — bounded shared window for repeat identical searches. The
  // results walk is slow (~21 s warm, up to ~26 s cold) and the served
  // response carried `private, no-cache, no-store`, so every repeat of the
  // SAME query paid the full cold fetch (measured before: p95 ~19 s, MISS on
  // every repeat). These headers let the shared edge layer answer a repeat
  // inside the window from the SAME live render — same scrapedAt stays
  // visible — while every miss still runs the live-per-query fan-out
  // (REEA-114 live-at-query-time policy untouched). Fresh window 45 s +
  // stale-serving tail 15 s bounds served age at ~60 s plus one fetch cycle
  // (issue AC-3); `max-age=0` keeps the browser honest. The URL query IS the
  // normalized search identity (`?q=` plus the `c`/`oos`/`page` view params);
  // locale stays a separate entry through the Accept-Language Vary, and the
  // Refresh button bypasses with a unique `?_r=` stamp (see ResultsClient).
  // Set here (not via next.config headers()) because the renderer overwrites
  // both Cache-Control and Vary during render — the middleware values are
  // what survive onto the final response on the platform.
  const path = request.nextUrl.pathname;
  if (path === "/results" || path === "/search") {
    response.headers.set("Cache-Control", RESULTS_CACHE_CONTROL);
    response.headers.set("Vary", "Accept-Language");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};