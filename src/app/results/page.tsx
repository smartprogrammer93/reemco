import ResultsClient from "@/components/ResultsClient";
import { collectLiveResults } from "@/lib/collect/live-search";
import { sanitizeCountry } from "@/lib/country";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";

export const metadata = {
  title: "Results — Reemco",
};

/**
 * REEA-114 — results are collected LIVE at query time. This handler runs per
 * request: the retailer search fan-out happens now, and its hits ARE the
 * served result set (no seed/snapshot arrays on this path). Every product
 * carries a real scrapedAt (collection completion), so freshness chips show
 * true ages that keep aging after render.
 */
export const dynamic = "force-dynamic";
// Headroom above the collector's bounded window on slow cold starts.
export const maxDuration = 20;

const PAGE_SIZE = 20;

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const query = sanitizeSearchQuery(params.q) ?? "";
  const page = sanitizePage(params.page);
  // REEA-170 — optional country selection (`?c=`); null keeps today's behavior.
  const country = sanitizeCountry(params.c);

  const { products } = await collectLiveResults(query, { country });
  const results = products;
  let suggestions = products.slice(0, 3);
  if (query && products.length === 0) {
    // Zero matches: re-collect once with the leading token so the empty state
    // suggests real live titles, not catalog fixtures.
    const relaxed = query.split(/\s+/)[0] ?? query;
    if (relaxed && relaxed !== query) {
      suggestions = (await collectLiveResults(relaxed, { country })).products.slice(0, 3);
    }
  }
  const offset = (page - 1) * PAGE_SIZE;
  const visible = results.slice(offset, offset + PAGE_SIZE);

  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      <ResultsClient
        query={query}
        page={page}
        products={visible}
        suggestions={suggestions}
      />
    </div>
  );
}
