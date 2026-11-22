import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

/**
 * Top-query result pages: the preset query pills the homepage itself serves
 * (design v4 hero band), so the long-tail inventory in the sitemap matches
 * what in-site links actually point at. Result pages stay force-dynamic and
 * collect offers live per query (REEA-114) — the sitemap only names the URLs.
 *
 * `/search?q=` renders the identical live path as `/results?q=` (see
 * src/app/search/page.tsx); only the /results shape used by every internal
 * link is listed, so the same page is not offered twice.
 */
const TOP_QUERIES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default function sitemap(): MetadataRoute.Sitemap {
  // Cached route handler (default), so the stamp refreshes with the cache.
  const now = new Date();
  // REEA-1051 — the origin follows REEMCO_SITE_ORIGIN (the host actually
  // serving), never a hard-coded rollback alias. See lib/site-origin.ts.
  const origin = siteOrigin();
  const corePages: MetadataRoute.Sitemap = [
    { url: origin, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${origin}/privacy`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${origin}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
  const queryPages: MetadataRoute.Sitemap = TOP_QUERIES.map((query) => ({
    url: `${origin}/results?q=${encodeURIComponent(query)}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.9,
  }));
  return [...corePages, ...queryPages];
}
