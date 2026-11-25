/**
 * REEA-1168 — the curated query seeds the sitemap starts from.
 *
 * The homepage's preset pills plus the category queries the live adapters
 * already answer. The sitemap merges these with the last-24 h top queries from
 * the existing anonymous funnel store (lib/trending-chips.ts) so the indexed
 * set tracks what shoppers actually search without hard-coding a changing
 * ranking. Every entry is a /results?q= URL — /search?q= is the duplicate
 * address and is deliberately not listed.
 *
 * Seeds are query strings, not bundled product data: the page behind each URL
 * still collects its offers live at request time.
 */
export const SITEMAP_QUERY_SEEDS: readonly string[] = [
  "iPhone 17 Pro",
  "WH-1000XM6",
  "Scope II keyboard",
  "headphones",
  "air fryer",
  "PlayStation 5",
  "Samsung Galaxy S26 Ultra",
  "laptop",
  "coffee machine",
  "power bank",
  "panadol",
  "cucumber",
];
