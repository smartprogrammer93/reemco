import type { NextConfig } from "next";

/**
 * REEA-439 — the bounded shared window for repeat identical searches now
 * lives with the other results-address response headers: see
 * sharedWindowHeaders() in src/proxy.ts. Moving it there keeps the window
 * and its locale Vary set together in middleware, where the renderer cannot
 * overwrite them; window/Vary regressions stay covered by
 * src/lib/repeat-search.test.ts. Identity is unchanged: the shared cache
 * keys on the URL — `?q=` plus the `c`/`oos`/`page` view params, locale via
 * the Accept-Language Vary — and Refresh bypasses with a unique `?_r=` stamp.
 *
 * REEA-437 — jsdom backs the Cloudflare-clearance hop inside
 * collect/live-search.ts (server-side only). Declaring it external keeps
 * Turbopack on native `require` for jsdom instead of tracing its Node `fs`
 * internals into the browser bundle the results page ships.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["jsdom"],
  // STATIC_EXPORT=1 ships a static snapshot for offline checks. The default
  // is the production server build (reemco.vercel.app on Vercel, or
  // `next start`) so the REEA-37 funnel endpoints under /api/events are served.
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" } : {}),
};

export default nextConfig;
