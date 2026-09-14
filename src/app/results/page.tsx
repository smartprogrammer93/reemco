import ResultsClient from "@/components/ResultsClient";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { recordSearchOutcome, searchOutcomeFromSnapshot, serveOutcomeOf } from "@/lib/metrics";
import { MARKET_COOKIE, resolveCountrySelection, filterProductsByCountry } from "@/lib/country";
import { LOCALE_COOKIE, resolveUiLocale } from "@/lib/i18n";
import { isRefreshSignal, REFRESH_COOKIE } from "@/lib/query-cache";
import { buildResultsMeta } from "@/lib/results-meta";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";
import { filterProductsByStock, sanitizeShowOutOfStock } from "@/lib/stock";
import { appendEvents } from "@/lib/event-store";
import { isBotUserAgent } from "@/lib/bot-ua";
import { buildRenderEvents } from "@/lib/metrics-events";
import { randomUUID } from "node:crypto";
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
// per-query completion budget (~2.8 s since REEA-693 item 1, ~1.8 s since
// REEA-756), but the hops still in flight
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
  userAgent: string | null;
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
      // REEA-965 — read for the shared bot-traffic decision only (FR-3.2);
      // the UA string itself is never stored on any event.
      userAgent: headersList.get("user-agent"),
    };
  } catch {
    return { cookie: undefined, localeCookie: undefined, acceptLanguage: null, refresh: false, userAgent: null };
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
  // REEA-965 — per-query-execution random id (FR-3.1): generated once per
  // render, rides the streamed props so client click events join the same
  // query execution's server-side search_performed. It is the ONLY
  // identifier any v1 event carries — no user/session/IP/fingerprint field
  // exists in the schema (AC-8). randomUUID is deterministic-per-call, not a
  // render-output clock, so no purity directive is needed here.
  const queryId = randomUUID();
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
  // REEA-871 — the latency-band clock: wall-clock from fan-out start (this
  // moment, immediately before the staged collection is kicked off) to the
  // after() recording below. Read once per render, server-side only; the raw
  // value never leaves the counter fold (only its band is stored).
  // eslint-disable-next-line react-hooks/purity -- intentional single clock read per server render (REEA-283 pattern); not a render output.
  const fanoutStartMs = Date.now();
  const staged = collectLiveResultsStaged(query, { refresh: hint.refresh, locale });
  // REEA-398 — keep the hops still in flight alive BEHIND the finalized
  // response: after() runs the run's allSettled chain once the document is
  // sent, so late offers converge into the cache and the follow-up feed
  // (which the hydrated page reads to fold them in in place) instead of
  // dying when the stream closes on the completion budget. Same single
  // live fan-out; no second round of requests.
  after(async () => {
    await staged.allSettled;    // REEA-807 — aggregate outcome counters, folded in the same after() tail
    // that keeps the run's hops alive: one live fan-out page serve = one
    // search; zero-offer and per-retailer offer counts read the fullest
    // answer the page ended with (REEA-921: the converged answer, else the
    // served document's own snapshot). Aggregate counters only —
    // no query content, no identifiers; storage is best-effort and must
    // never surface as a failed render.
    // REEA-871 — the same recording carries the approved aggregate
    // extension: the cold-serve outcome, the fan-out wall-clock latency
    // banded into exactly one bucket, and the round-one adapter
    // attempts/failures read off the run's own telemetry. Still
    // aggregate-only; a rejected converged chain counts the search with the
    // honest pending outcome rather than no outcome.
    // REEA-921 guardrail — "full" means the shopper's page reached full
    // offers: the outcome reads the snapshot the SERVED DOCUMENT carried
    // (staged.final) plus whether the registered follow-up delivered the
    // converged answer (staged.converged — the same promise the follow-up
    // feed folds into the open page), so a truncated serve whose follow-up
    // delivered and an already-settled document classify identically
    // instead of the same shopper-visible state splitting pending-at-<1s vs
    // full-at-3-10s across repeats. Offer counts still read the fullest
    // answer the page ended with (converged when it exists, else the served
    // document's own snapshot). Aggregate-only; nothing new is stored
    // beyond the existing full/pending split.
    if (query) {
      const [served, convSnap, adapterTelemetry] = await Promise.all([
        staged.final.then(
          (s) => s,
          () => null,
        ),
        staged.converged.then(
          (s) => s,
          () => null,
        ),
        staged.adapterTelemetry.catch(() => ({ attempts: {}, failures: {} })),
      ]);
      const pageSnap = convSnap ?? served;
      await recordSearchOutcome({
        ...(pageSnap
          ? searchOutcomeFromSnapshot(pageSnap)
          : { zeroOffers: false, offersByRetailer: {} }),
        serveOutcome: serveOutcomeOf(served, convSnap),
        // eslint-disable-next-line react-hooks/purity -- the recording clock is read in the deferred after() tail, never during render output.
        serveLatencyMs: Math.max(0, Date.now() - fanoutStartMs),
        adapterAttempts: adapterTelemetry.attempts,
        adapterFailures: adapterTelemetry.failures,
      });
    }
  });

  // REEA-965 — server-side v1 render events (R2 spec FR-3): one
  // search_performed per query execution, zero_result_shown when the primary
  // result set is empty. Emitted in the after() tail — the document is
  // already sent, so the sink can never delay render (AC-9, and E8: a
  // failing sink is logged nowhere the shopper can see). Bot/health-check
  // traffic is excluded by the shared UA definition (FR-3.2) so the
  // zero-result rate reflects humans. resultCount reads the fullest answer
  // the page ended with (converged, else the served snapshot) after the SAME
  // country/stock filters the client applies to the visible set — the total
  // across pages, since resultCount is the query's primary result count, not
  // one page slice. relatedCount is 0 until the R2 confidence hierarchy
  // (REEA-964) supplies the classified split.
  after(async () => {
    if (!query || isBotUserAgent(hint.userAgent)) return;
    try {
      const snap = (await staged.converged.then(
        (s) => s,
        () => null,
      )) ?? (await staged.final.then(
        (s) => s,
        () => null,
      ));
      const visible = snap
        ? filterProductsByStock(filterProductsByCountry(snap.products, country), showOutOfStock)
        : [];
      const events = buildRenderEvents({
        queryId,
        query,
        primaryCount: visible.length,
        relatedCount: 0,
      });
      if (events.length > 0) await appendEvents(events);
    } catch {
      // Fire-and-forget (E8): a metrics write failure must never surface.
    }
  });

  return (
    <div
      className="results-viewport-reserve mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      <ResultsClient
        query={query}
        queryId={queryId}
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
