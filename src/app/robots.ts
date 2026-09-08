import type { MetadataRoute } from "next";

/**
 * REEA-278 — /robots.txt served as plain text instead of falling through to
 * the HTML app shell. The file names the sitemap so crawlers get one entry
 * point for the indexed set; everything is crawlable (no private areas on a
 * price-comparison funnel site).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: "https://reemco.vercel.app/sitemap.xml",
  };
}
