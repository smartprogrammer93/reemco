import ResultsClient from "@/components/ResultsClient";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { MARKET_COOKIE, resolveCountrySelection } from "@/lib/country";
import { LOCALE_COOKIE, resolveUiLocale } from "@/lib/i18n";
import { isRefreshSignal, REFRESH_COOKIE } from "@/lib/query-cache";
import { buildResultsMeta } from "@/lib/results-meta";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";
import { sanitizeShowOutOfStock } from "@/lib/stock";
import type { Metadata } from "next";
import { after } from "next/server";
import { cookies, headers } from "next/headers";

type ResultsSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * REEA-400 — each results query is its own indexed landing surface: the
 * title carries the query ("<query> prices in <country> - Reemco"; Arabic:
 * "أسعار <query> في الكويت - ريمكو") plus a short matching description.
 * Composition is the pure buildResultsMeta helper on the same request-time
 * signals the page body already reads (rc_locale / rc_market cookies, the
 * coarse Accept-Language hint, `?q=` / `?c=`); the empty-query fallback keeps
 * a market-scoped title instead of a bare "Results" shell. Replaces the old
 * static `metadata` object — one export per segment (generate-metadata docs).
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: ResultsSearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const query = sanitizeSearchQuery(params.q) ?? "";
  const hint = await readPreferenceHint();
  const country = resolveCountrySelection(params.c, hint.cookie, hint.acceptLanguage);
  // REEA-448 G2 — the query text is the third link of the chain: with no
  // cookie and no Accept-Language header, an Arabic-script query decides the
  // session, so "آيفون" gets the Arabic title template instead of the mixed
  // "آيفون prices in Kuwait - Reemco".
  const locale = resolveUiLocale(hint.localeCookie, hint.acceptLanguage, query);
  const meta = buildResultsMeta({ query, country, locale });
  return { title: meta.title, description: meta.description };
}

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
// Ceiling for the whole query-time walk. REEA-398: the RESPONSE closes on the
// per-query completion budget (~2.8 s finalize since REEA-693 item 1), but the
// hops still in flight
// at finalize keep running behind it via after()/allSettled — hop ceiling
// LIVE_SEARCH_BUDGET_MS plus converge and cache write-through — and the
// follow-up feed reads that same run right after. The ceiling keeps the whole
// behind-the-response tail inside the same warm window — same headroom tier
// as the probe's 45 s. At 20 s the platform closed the stream right when the
// last staged boundary was flushing (React #412 "Connection closed" + error
// card; QA REEA-391), which truncated exactly the converged snapshot the
// shopper is waiting for.
export const maxDuration = 45;

/** Request-time preference layers (REEA-280). Both reads are request-time
 *  APIs, so on a prerendered/static host they fall back silently to the
 *  pre-feature "All" default instead of failing the shell render. */
async function readPreferenceHint(): Promise<{
  cookie: string | undefined;
  localeCookie: string | undefined;
  acceptLanguage: string | null;
  refresh: boolean;
}> {
  try {
    const cookieStore = await cookies();
    const headersList = await headers();
    return {
      cookie: cookieStore.get(MARKET_COOKIE)?.value,
      localeCookie: cookieStore.get(LOCALE_COOKIE)?.value,
      acceptLanguage: headersList.get("accept-language"),
      // REEA-291 AC4 — the one-shot Refresh signal rides the same request-time
      // cookie read: this render re-collects live instead of taking the memo.
      refresh: isRefreshSignal(cookieStore.get(REFRESH_COOKIE)?.value),
    };
  } catch {
    return { cookie: undefined, localeCookie: undefined, acceptLanguage: null, refresh: false };
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
  // eslint-disable-next-line react-hooks/purity -- intentional single clock read per server render (REEA-283); hydration reuses the serialized value.
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
  // REEA-279 — the same request-time read resolves the chrome locale: the
  // rc_locale cookie wins, then the coarse Accept-Language hint, then the
  // Arabic-script query text (REEA-448 G2), then "en" — the same call the
  // metadata above makes, so chrome and title never fork on locale.
  const locale = resolveUiLocale(hint.localeCookie, hint.acceptLanguage, query);
  // REEA-186 — stock selection (`?oos=1` shows out-of-stock listings).
  // Default hides them; the ResultsClient view applies it BEFORE slicing each
  // staged snapshot so counts and pages match the visible set. Offers stay
  // live-collected; this only selects among the freshly fetched set.
  const showOutOfStock = sanitizeShowOutOfStock(params.oos) ?? false;

  // Fan-out starts here; rendering does not wait for the slowest adapter.
  // REEA-291 AC4/AC5 — the collection is the FULL live answer for the query;
  // the country/stock selections are applied by ResultsClient as render-time
  // filters over this already-loaded payload, so changing a toggle needs no
  // second round-trip. That also makes the memoized answer per QUERY exactly
  // right: one live fan-out serves every market view, so the response cache
  // keys on the normalized query string only and never forks on viewer-side
  // signals. Coverage notes describe the whole fan-out the page actually ran.
  // The ONE exception is the explicit Refresh action (REFRESH_COOKIE), which
  // always re-runs the live collection so its timestamps move.
  const staged = collectLiveResultsStaged(query, { refresh: hint.refresh, locale });
  // REEA-398 — keep the hops still in flight alive BEHIND the finalized
  // response: after() runs the run's allSettled chain once the document is
  // sent, so late offers converge into the cache and the follow-up feed
  // (which the hydrated page reads to fold them in in place) instead of
  // dying when the stream closes on the completion budget. Same single
  // live fan-out; no second round of requests.
  after(async () => {
    await staged.allSettled;
  });

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
        locale={locale}
        stages={staged.stages}
        renderStartMs={renderStartMs}
      />
    </div>
  );
}
