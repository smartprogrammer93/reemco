import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { RESULTS_PATHS, sharedWindowHeaders } from "./src/proxy";

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
  // string. The buildCommand (vercel.json) stamps __commit.txt with
  // ${VERCEL_GIT_COMMIT_SHA:-$(git rev-parse HEAD)}; mirror that exact chain
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
  serverExternalPackages: ["jsdom"],
  headers: async () => {
    const windowHeaders = sharedWindowHeaders();
    return RESULTS_PATHS.map((source) => ({
      source,
      headers: Object.entries(windowHeaders).map(([key, value]) => ({ key, value })),
    }));
  },
  // STATIC_EXPORT=1 ships a static snapshot for offline checks. The default
  // is the production server build (reemco.vercel.app on Vercel, or
  // `next start`) so the REEA-37 funnel endpoints under /api/events are served.
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" } : {}),
};

export default nextConfig;
