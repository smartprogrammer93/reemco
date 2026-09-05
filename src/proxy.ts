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
    // Stage 1 (REEA-74): no `https: http:` host fallback — those wildcards
    // widen script-src to any HTTPS origin. 'self' + per-request nonce +
    // 'strict-dynamic' covers the app; legacy browsers fall back to 'self'.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // 'unsafe-inline' is ignored by modern browsers when nonces are present;
    // kept as a fallback for legacy browsers only.
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
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
