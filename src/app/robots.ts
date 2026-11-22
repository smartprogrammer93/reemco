import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

// REEA-1051 — see sitemap.ts: robots handlers are cached at build by default,
// so force a per-request render to read the runtime serving origin.
export const dynamic = "force-dynamic";

/**
 * REEA-278 — /robots.txt served as plain text instead of falling through to
 * the HTML app shell. The file names the sitemap so crawlers get one entry
 * point for the indexed set; everything is crawlable (no private areas on a
 * price-comparison funnel site).
 *
 * REEA-1051 — the sitemap URL follows the serving host (REEMCO_SITE_ORIGIN)
 * instead of the hard-coded Vercel alias, so a crawler that finds the box does
 * not get pointed at the retired rollback host.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
