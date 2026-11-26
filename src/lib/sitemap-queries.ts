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
import type { FunnelEvent } from "@/lib/events";

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

/** REEA-1189 — the sitemap must not submit a query that renders an empty
 *  page. Same 24 h window the trending chip row reads, and the same
 *  result_count signal the funnel already stores on search_submitted /
 *  search_performed: only a query whose MOST RECENT observed search returned
 *  at least one result stays eligible for indexing. */
export const SITEMAP_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Case-folded query strings whose latest in-window search had ≥1 result. */
export function queriesWithResults(
  events: readonly FunnelEvent[],
  nowMs: number,
): Set<string> {
  const latest = new Map<string, { ts: number; count: number }>();
  for (const event of events) {
    if (event.type !== "search_submitted" && event.type !== "search_performed") continue;
    const query = event.query?.trim();
    if (!query) continue;
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < nowMs - SITEMAP_QUERY_WINDOW_MS) continue;
    const count = event.result_count ?? event.resultCount ?? 0;
    const key = query.toLowerCase();
    const previous = latest.get(key);
    if (!previous || ts > previous.ts) latest.set(key, { ts, count });
  }
  const out = new Set<string>();
  for (const [query, entry] of latest) {
    if (entry.count >= 1) out.add(query);
  }
  return out;
}

/** Curated seeds always stay; a trending query stays only when its latest
 *  search actually returned a result. Case-folded dedupe, order preserved. */
export function selectSitemapQueries(
  seeds: readonly string[],
  trending: readonly string[],
  indexable: ReadonlySet<string> | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (query: string): void => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const query of seeds) push(query);
  for (const query of trending) {
    if (indexable !== null && !indexable.has(query.trim().toLowerCase())) continue;
    push(query);
  }
  return out;
}
