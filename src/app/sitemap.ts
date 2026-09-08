import type { MetadataRoute } from "next";

/** Canonical origin of the live site (Vercel project domain). */
const SITE_ORIGIN = "https://reemco.vercel.app";

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
  const corePages: MetadataRoute.Sitemap = [
    { url: SITE_ORIGIN, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_ORIGIN}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_ORIGIN}/privacy`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_ORIGIN}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
  const queryPages: MetadataRoute.Sitemap = TOP_QUERIES.map((query) => ({
    url: `${SITE_ORIGIN}/results?q=${encodeURIComponent(query)}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.9,
  }));
  return [...corePages, ...queryPages];
}
