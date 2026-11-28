import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { RESULTS_PATHS, sharedWindowHeaders, sitemapCacheHeaders } from "./src/proxy";

/**
 * REEA-439 — the bounded shared window for repeat identical searches is built
 * once by sharedWindowHeaders() in src/proxy.ts (window + locale Vary keep one
 * identity; repeat-search.test.ts pins the builder). REEA-447 R5 — the window
 * is ALSO declared here via headers(), which Next applies to the FINAL served
 * response after rendering: on the deployed head the middleware-set pair was
 * overwritten by the renderer's own dynamic-page headers (every unique search
 * paid a full origin render — x-vercel-cache MISS, age 0). Config headers
 * survive that rewrite, so the served /results response carries the bounded
 * shared-cache window; scripts/smoke-check.mjs asserts it on the wire.
 * Identity is unchanged: the shared cache keys on the URL — `?q=` plus the
 * `c`/`oos`/`page` view params, locale via the Accept-Language Vary — and
 * Refresh bypasses with a unique `?_r=` stamp (see src/lib/query-cache.ts).
 *
 * REEA-437 — jsdom backs the Cloudflare-clearance hop inside
 * collect/live-search.ts (server-side only). Declaring it external keeps
 * Turbopack on native `require` for jsdom instead of tracing its Node `fs`
 * internals into the browser bundle the results page ships.
 */
const nextConfig: NextConfig = {
  // REEA-729 stamp parity — the RSC payload build id (`"b"` in the served
  // shell) and public/__commit.txt must name the same artifact with the same
  // string. infra/Dockerfile stamps __commit.txt with the REEMCO_COMMIT build
  // arg and exports it as VERCEL_GIT_COMMIT_SHA; mirror that exact chain
  // here so the Next build id is that same SHA instead of an opaque random
  // id, and both verification lanes (commit endpoint vs payload) grade one value.
  generateBuildId: async () => {
    const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
    if (sha) return sha;
    try {
      return execSync("git rev-parse HEAD").toString().trim();
    } catch {
      // No git metadata and no Vercel env (plain local runs): Next's default
      // random per-build id is fine — it only needs to bind chunks to chunks.
      return "";
    }
  },
  // REEA-1084 (F7a) — framework fingerprinting. Next defaults to
  // `X-Powered-By: Next.js` on every response; it tells an attacker which
  // framework to probe and buys the shopper nothing. Suppress it at the source
  // rather than stripping it in Caddy, so loopback and the public surface agree
  // and infra/scripts/verify.sh can gate both (`Server` is already suppressed at
  // the edge). Pinned by src/next-config.test.ts.
  poweredByHeader: false,
  serverExternalPackages: ["jsdom", "playwright-core", "@sparticuz/chromium"],
  // REEA-1221 — the browser clearance tier (collect/browser-clearance.ts) runs
  // a real Chromium from `@sparticuz/chromium`, whose executable is extracted
  // from `bin/*.br` at run time. Next's tracer follows the JS imports but not
  // that package-relative binary path, so the standalone image would launch
  // nothing without an explicit include.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      // playwright-core reads browsers.json (and the per-driver json files)
      // from its own package root at run time; the tracer only follows the JS
      // imports, so the deployed runtime failed with
      // "Cannot find module '/app/node_modules/playwright-core/browsers.json'"
      // (measured on the served head 2026-11-26). Ship the package's data
      // files with the bundle.
      "./node_modules/playwright-core/**/*.json",
    ],
  },
  headers: async () => {
    const windowHeaders = sharedWindowHeaders();
    return [
      ...RESULTS_PATHS.map((source) => ({
        source,
        headers: Object.entries(windowHeaders).map(([key, value]) => ({ key, value })),
      })),
      // REEA-1269 S-6 — the crawler artifact carries its own bounded shared
      // window (the renderer rewrites dynamic-route cache headers, config
      // headers survive; same mechanism as the results window above).
      {
        source: "/sitemap.xml",
        headers: Object.entries(sitemapCacheHeaders()).map(([key, value]) => ({ key, value })),
      },
    ];
  },
  // STATIC_EXPORT=1 ships a static snapshot for offline checks. The default
  // is the production server build (the self-hosted box, or `next start`) so
  // the REEA-37 funnel endpoints under /api/events are served.
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" } : {}),
  // REEA-1044 — the self-hosted image (infra/Dockerfile) builds with
  // NEXT_OUTPUT=standalone so `node server.js` runs from a traced bundle
  // instead of shipping the whole node_modules tree. Unset on Vercel, so the
  // existing deployment output mode is unchanged.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  experimental: {
    // REEA-1275 — the first-card budget is gated on the render-blocking route
    // stylesheet: measured on the served head, the browser's FCP landed only
    // after that ~0.9 s request (the production host answers every request
    // with that floor), and the first card cannot paint before FCP. Inlining
    // the route CSS into the served document removes one render-blocking
    // round-trip from the critical path; the CSP already allows inline styles
    // (`style-src 'self' 'unsafe-inline'`). The stylesheet content is
    // unchanged — only its delivery does — so the design tokens and layout
    // are byte-identical.
    inlineCss: true,
  },
};

export default nextConfig;
