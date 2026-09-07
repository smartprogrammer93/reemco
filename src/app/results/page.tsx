import ResultsClient from "@/components/ResultsClient";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { sanitizeCountry } from "@/lib/country";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";
import { sanitizeShowOutOfStock } from "@/lib/stock";

export const metadata = {
  title: "Results — Reemco",
};

/**
 * REEA-114 — results are collected LIVE at query time. This handler runs per
 * request: the retailer search fan-out happens now, and its hits ARE the
 * served result set (no seed/snapshot arrays on this path). Every product
 * carries a real scrapedAt (collection completion), so freshness chips show
 * true ages that keep aging after render.
 *
 * REEA-178 — the handler no longer blocks on the FULL collection: it starts
 * the same per-retailer live fan-out, hands the per-stage promises to
 * ResultsClient, and lets the Suspense boundaries flush a merged-so-far
 * snapshot as each adapter answers, so the first price shows well before the
 * slowest hop finishes. The final stage carries the exact full-ranked
 * snapshot the blocking path produced — both paths share one final results-
 * render, live-per-query fetch preserved, no bundled/static snapshot.
 */
export const dynamic = "force-dynamic";
// Headroom above the collector's bounded window on slow cold starts.
export const maxDuration = 20;

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
  // REEA-186 — stock selection (`?oos=1` shows out-of-stock listings).
  // Default hides them; the ResultsClient view applies it BEFORE slicing each
  // staged snapshot so counts and pages match the visible set. Offers stay
  // live-collected; this only selects among the freshly fetched set.
  const showOutOfStock = sanitizeShowOutOfStock(params.oos) ?? false;

  // Fan-out starts here; rendering does not wait for the slowest adapter.
  const staged = collectLiveResultsStaged(query, { country });

  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      <ResultsClient
        query={query}
        page={page}
        country={country}
        showOutOfStock={showOutOfStock}
        stages={staged.stages}
      />
    </div>
  );
}
