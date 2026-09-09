import type { NextConfig } from "next";

/**
 * REEA-439 — bounded-staleness shared cache for repeat identical searches.
 *
 * The results walk is slow (~21 s warm, up to ~26 s cold), and the served
 * response carried `private, no-cache, no-store`, so EVERY repeat of the SAME
 * query — even seconds later, even against a warm instance — paid the full
 * cold fetch (measured before this change: p95 ~19 s, `x-vercel-cache: MISS`
 * on every repeat). This header lets the shared edge layer answer a repeat
 * inside the window from the SAME live render (same scrapedAt stays visible),
 * while every miss still runs the live-per-query fan-out — the REEA-114
 * live-at-query-time policy is untouched; only the ANSWER of one live run is
 * shared for about a minute.
 *
 * Bounded staleness (AC-3): fresh window 45 s + stale-serving tail 15 s, so
 * the worst served age is 60 s plus one fetch cycle — inside the 30–60 s
 * band, and the freshness chip keeps showing the true stamp. `max-age=0`
 * keeps the browser honest: a repeat always asks the shared layer (fast
 * HIT/304) rather than rendering a longer-lived local snapshot.
 *
 * Identity: the shared cache keys on the URL, whose query string IS the
 * normalized search (`?q=` plus the `c`/`oos`/`page` view params; locale is
 * carried by the Accept-Language Vary). Same per-query identity as the memo
 * in src/lib/query-cache.ts. Refresh bypasses with a unique `?_r=` stamp.
 */
const RESULTS_CACHE_CONTROL =
  "public, max-age=0, s-maxage=45, stale-while-revalidate=15";

// Both addresses run the same staged live-collection walk (see
// src/app/search/page.tsx), so both share one bounded window.
const RESULTS_PATHS = ["/results", "/search"] as const;

const nextConfig: NextConfig = {
  // STATIC_EXPORT=1 ships a static snapshot for offline checks. The default
  // is the production server build (reemco.vercel.app on Vercel, or
  // `next start`) so the REEA-37 funnel endpoints under /api/events are served.
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" } : {}),
  async headers() {
    return RESULTS_PATHS.map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: RESULTS_CACHE_CONTROL },
        // Locale must not share entries: each Accept-Language variant keeps
        // its own bounded entry (issue: normalized query keeps locale).
        { key: "Vary", value: "Accept-Language" },
      ],
    }));
  },
};

export default nextConfig;
