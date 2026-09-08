import ResultsClient from "@/components/ResultsClient";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { MARKET_COOKIE, resolveCountrySelection } from "@/lib/country";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";
import { sanitizeShowOutOfStock } from "@/lib/stock";
import { cookies, headers } from "next/headers";

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

/** Request-time preference layers (REEA-280). Both reads are request-time
 *  APIs, so on a prerendered/static host they fall back silently to the
 *  pre-feature "All" default instead of failing the shell render. */
async function readPreferenceHint(): Promise<{
  cookie: string | undefined;
  acceptLanguage: string | null;
}> {
  try {
    const cookieStore = await cookies();
    const headersList = await headers();
    return {
      cookie: cookieStore.get(MARKET_COOKIE)?.value,
      acceptLanguage: headersList.get("accept-language"),
    };
  } catch {
    return { cookie: undefined, acceptLanguage: null };
  }
}

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  // REEA-283 — one clock reading per server render. It rides the streamed
  // props and hydration reuses the serialized value, so the freshness chip's
  // minute figure is identical in the served HTML and after hydration.
  const renderStartMs = Date.now();
  const query = sanitizeSearchQuery(params.q) ?? "";
  const page = sanitizePage(params.page);
  // REEA-170 — optional country selection (`?c=`); null keeps today's behavior.
  // REEA-280 — with no explicit param the default is the persisted market
  // choice from the language-preference cookie, then the coarse
  // Accept-Language hint (ar-KW/en-KW → KW), so a Kuwait shopper lands on
  // KWD-first local offers instead of a mixed KWD/SAR/EGP list. One tap on a
  // pill overwrites the hint and persists across sessions.
  const hint = await readPreferenceHint();
  const country = resolveCountrySelection(params.c, hint.cookie, hint.acceptLanguage);
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
        renderStartMs={renderStartMs}
      />
    </div>
  );
}
