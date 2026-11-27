import ResultsClient from "@/components/ResultsClient";
import ResultsPageViewBeacon from "@/components/ResultsPageViewBeacon";
import ResultsStructuredData from "@/components/ResultsStructuredData";
import { Suspense } from "react";
import { collectLiveResultsStagedAdmitted } from "@/lib/collect/live-search";
import type { LiveSearchResult, LiveSearchStages } from "@/lib/collect/live-search";
// REEA-1261 AC-1/AC-2 — the exact-model card folded into every served
// snapshot: the same stored last observation the PDP seeds with, and the
// idempotent merge that never overrides a fresher live row.
import { exactModelShelfSeed } from "@/lib/collect/last-observation";
import { withExactModelCard } from "@/lib/exact-model-seed";
import { COLD_RECORDING_CAP_MS, recordSearchOutcome, searchOutcomeFromSnapshot, serveOutcomeOf } from "@/lib/metrics";
// REEA-1237 (PM scope extension) — per-week aggregate {term, count} rows for
// the zero-offer / filtered-empty Pareto. Aggregate-only, shopper serves only.
import { recordQueryTerm } from "@/lib/query-terms";
// REEA-1099 — the ONE results-page shelf card definition the renderer uses;
// the comparison-depth counter folds over this same set.
import { resultsShelfCards } from "@/lib/results-shelf";
// REEA-1141 AC-4 — the served streamed shelf's paint chain and its duplicate
// fold: the SAME helpers the StageAppend boundaries run, so the counter can
// never describe a different population than the page painted.
import { paintedShelfCardsAcrossStages, duplicateCardsOf } from "@/lib/results-shelf";
// REEA-1114 AC6 — the false-empty numerator: the SAME filter-aware
// classification the empty state renders, folded into one aggregate counter.
import { hiddenShelfMatches } from "@/lib/hidden-matches";
// REEA-1078 S2 — the serve path applies the persisted dead-lane retirement set
// on top of the static retirement (see lib/collect/lane-health.ts).
import { readLaneRetirement, recordLaneAttempts } from "@/lib/collect/lane-health";
// REEA-1078 AC9 — lane reachability from the same zone status /api/echo reports.
import { readUnreachableLanes } from "@/lib/collect/zone-status";
import { MARKET_COOKIE, resolveResultsMarket } from "@/lib/country";
import {
  countCrossMarketOffers,
  HOME_MARKET,
  marketViewScope,
  scopeProductsByMarket,
} from "@/lib/market";
import { LOCALE_COOKIE, resolveUiLocale } from "@/lib/i18n";
import { isRefreshSignal, REFRESH_COOKIE } from "@/lib/query-cache";
import { buildResultsMeta } from "@/lib/results-meta";
import { siteOrigin } from "@/lib/site-origin";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";
import { filterProductsByStock, resolveResultsStock } from "@/lib/stock";
import { appendEvents } from "@/lib/event-store";
import { isBotUserAgent } from "@/lib/bot-ua";
import { buildRenderEvents } from "@/lib/metrics-events";
import { partitionByConfidence } from "@/lib/confidence";
import { exactSkuKeep } from "@/lib/relevance";
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
  const country = resolveResultsMarket(params.market, params.c, hint.cookie, hint.acceptLanguage);
  // REEA-448 G2 — the query text is the third link of the chain: with no
  // cookie and no Accept-Language header, an Arabic-script query decides the
  // session, so "آيفون" gets the Arabic title template instead of the mixed
  // "آيفون prices in Kuwait - Reemco".
  const locale = resolveUiLocale(hint.localeCookie, hint.acceptLanguage, query);
  const meta = buildResultsMeta({ query, country, locale });
  // REEA-1168 AC-3 — the query surface keeps ONE canonical shape: /results?q=
  // (never the /search duplicate, never the market/stock filter params, which
  // are viewer selections over the same live payload). Page 2+ names its page
  // so the canonical matches the slice the document actually renders. The
  // encoding matches every internal /results link (encodeURIComponent), so a
  // crawler sees the same URL string the site itself emits.
  const page = sanitizePage(params.page);
  const queryPart = query ? `?q=${encodeURIComponent(query)}` : "";
  const pagePart = page > 1 ? `${queryPart ? "&" : "?"}page=${page}` : "";
  const canonical = `${siteOrigin()}/results${queryPart}${pagePart}`;
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical },
  };
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
  const country = resolveResultsMarket(params.market, params.c, hint.cookie, hint.acceptLanguage);
  // REEA-279 — the same request-time read resolves the chrome locale: the
  // rc_locale cookie wins, then the coarse Accept-Language hint, then the
  // Arabic-script query text (REEA-448 G2), then "en" — the same call the
  // metadata above makes, so chrome and title never fork on locale.
  const locale = resolveUiLocale(hint.localeCookie, hint.acceptLanguage, query);
  // REEA-186 — stock selection (`?oos=1` shows out-of-stock listings).
  // Default hides them; the ResultsClient view applies it BEFORE slicing each
  // staged snapshot so counts and pages match the visible set. Offers stay
  // live-collected; this only selects among the freshly fetched set.
  const showOutOfStock = resolveResultsStock(params.stock, params.oos);

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
  // REEA-1078 S2 — retired lanes never enter this fan-out. REEA-1078 AC9 — the
  // coverage sentence names a blocked lane as unreachable instead of letting
  // its silent zero read as a coverage statement. Both reads are small shared-
  // store GETs memoized per instance for a minute and are issued together so
  // they cannot serialize extra latency onto the fan-out (AC-8); either one
  // fails OPEN (nothing extra retired / no label) so instrumentation can never
  // blank a search.
  const [retirement, unreachableLanes] = await Promise.all([
    readLaneRetirement(),
    readUnreachableLanes(),
  ]);
  const { retired: retiredLanes, readmitted: readmittedLanes } = retirement;
  // REEA-1261 AC-1/AC-2 — the exact-model card, read CONCURRENTLY with the
  // fan-out (it is one small shared-store GET; issuing it here keeps it off
  // the critical path). It is the same evidence the PDP seeds with
  // (lib/collect/last-observation): the catalog supplies the identity, the
  // store supplies the last COMPLETED live observation, marked "cache" so the
  // card reads "Needs verification" and never claims this run's cross-check.
  // Null for category/brand-only/model-only queries and when no fresh stored
  // observation exists — then the live fan-out's answer stands untouched.
  const exactSeedPromise = query
    ? exactModelShelfSeed(query, renderStartMs)
    : Promise.resolve(null);
  // REEA-1133 — the page-path fan-out goes through the process-wide admission
  // cap with a bounded, FAIL-CLOSED wait (src/lib/collect/inflight.ts), so N
  // distinct queries queue behind the ceiling instead of each multiplying the
  // retailer lanes. A render that cannot be admitted serves an honest pending
  // shell and the same run is deferred behind the response: the follow-up feed
  // (REEA-398) still folds its live answer into the open page.
  const staged = await collectLiveResultsStagedAdmitted(query, { refresh: hint.refresh, locale, retiredLanes, readmittedLanes });
  const exactSeed = await exactSeedPromise.catch(() => null);
  // REEA-1261 — fold the exact-model card into EVERY snapshot this serve can
  // paint (the streamed stages, the finalized document and the run's converged
  // answer). The helper is idempotent: a snapshot that already carries the
  // identity (the live fan-out answered with it) is returned unchanged, so
  // this can never duplicate a card or override a fresher live row. The
  // after() fold reads the SAME wrapped promises, so `comparison_depth` counts
  // exactly the shelf the shopper's page painted (REEA-1099).
  const withExactModel = (snap: LiveSearchResult): LiveSearchResult =>
    exactSeed === null
      ? snap
      : {
          ...snap,
          products: withExactModelCard(snap.products, exactSeed, query),
        };
  const seededStaged: LiveSearchStages = {
    ...staged,
    stages: staged.stages.map((stage) => stage.then(withExactModel)),
    final: staged.final.then(withExactModel),
    converged: staged.converged.then(withExactModel),
    allSettled: staged.allSettled.then((snap) => (snap ? withExactModel(snap) : snap)),
  };
  // REEA-398 — keep the hops still in flight alive BEHIND the finalized
  // response: after() runs the run's allSettled chain once the document is
  // sent, so late offers converge into the cache and the follow-up feed
  // (which the hydrated page reads to fold them in in place) instead of
  // dying when the stream closes on the completion budget. Same single
  // live fan-out; no second round of requests.
  after(async () => {
    // REEA-1078 — the serve clock is read on ENTRY to the deferred tail (the
    // document has been sent by the time after() runs). For a warm memo hit
    // that elapsed time is the shopper's serve latency; for a cold serve the
    // recording below reads the collection clock after allSettled instead.
    // eslint-disable-next-line react-hooks/purity -- deferred after() tail, not render output.
    const afterEntryMs = Date.now();
    // REEA-1148 — bounded converged wait: resolves with the converged
    // snapshot when the chain lands inside the structural tail cap, null AT
    // the cap. The recording clock below is read on THIS resolution, so a
    // cold serve can never be banded past the cap its methodology documents
    // (the previous code awaited staged.converged unbounded, which is where
    // the >10 s band came from).
    const convSnapAtCap = await seededStaged.allSettled;    // REEA-807 — aggregate outcome counters, folded in the same after() tail
    // REEA-1078/REEA-1148 — warm serves keep the serve-entry clock; a cold
    // serve records the bounded collection clock read right here, clamped to
    // the structural cap so latency_band_gt_10s is unreachable by construction.
    // eslint-disable-next-line react-hooks/purity -- deferred after() tail, not render output.
    const capClockMs = Date.now();
    const recordedMs =
      seededStaged.serveKind === "warm" ? afterEntryMs : Math.min(capClockMs, fanoutStartMs + COLD_RECORDING_CAP_MS);
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
      const [served, adapterTelemetry] = await Promise.all([
        seededStaged.final.then(
          (s) => s,
          () => null,
        ),
        seededStaged.adapterTelemetry.catch(() => ({ attempts: {}, failures: {} })),
      ]);
      // REEA-1148 — the outcome/offer counters keep the REEA-921 definition
      // (did the registered follow-up deliver the converged answer?), which
      // is a separate question from the capped latency clock above. When the
      // cap won the bounded wait, await the converged chain for this
      // classification only — the recorded clock was already taken at the
      // cap, so a long convergence can never re-open the >10 s band.
      const convSnap = convSnapAtCap ?? (await seededStaged.converged.then((s) => s, () => null));
      const pageSnap = convSnap ?? served;
      // REEA-1099 — comparison depth is folded over the SAME shelf the page
      // paints (the primary slice of the filtered, confidence-partitioned
      // snapshot), never every product the snapshot carries: related-band
      // rows and selection-dropped rows are not results-page cards. The
      // shared helper is the renderer's own chain, so counter and page agree.
      const shelfCards = pageSnap
        ? resultsShelfCards(pageSnap, query, 1, country, showOutOfStock)
        : [];
      // REEA-1142 AC5 — the cross-market share of the SAME shelf the page
      // painted: offers whose market differs from the selected market (e.g.
      // danube.sa SAR rows on a Kuwait search). Aggregate integer only.
      const crossMarketOffers = shelfCards.reduce(
        (n, p) => n + countCrossMarketOffers(p.offers, marketViewScope(country)),
        0,
      );
      // REEA-1267 — the false-empty numerator, corrected to the meaning its
      // own docs state ("the false-empty the shopper SAW"). REEA-1114 counted
      // every serve whose zero visible set was caused by an active filter —
      // including the honest ones, whose page already says "N matches hidden
      // by In stock — show all". The counter now counts the LIE: the served
      // document presented the no-match state (its own snapshot carried zero
      // hidden matches, so no escape could render) while the run's converged
      // answer held ≥1 confident in-scope match the active filter hides. The
      // escape and the count ride the SAME painted shelf chain the renderer
      // uses (lib/hidden-matches.ts + lib/results-shelf.ts), so this cannot
      // describe a different population than the page. One boolean per serve;
      // no query text, no per-query record.
      const servedShelfEmpty = served
        ? resultsShelfCards(served, query, 1, country, showOutOfStock).length === 0
        : false;
      const servedHidden = served
        ? hiddenShelfMatches(served.products, query, 1, country, showOutOfStock).cards.length
        : 0;
      const runHidden = pageSnap
        ? hiddenShelfMatches(pageSnap.products, query, 1, country, showOutOfStock).cards.length
        : 0;
      const filteredEmpty = servedShelfEmpty && servedHidden === 0 && runHidden > 0;
      // REEA-1267 — the population REEA-1114 published is kept as its OWN
      // aggregate so the hiding rate stays visible beside the residual lie
      // rate: an EMPTY shelf whose zero was caused by an active filter hiding
      // ≥1 confident match (the same predicate REEA-1114 folded, so the weekly
      // trend is comparable across the change). The escape explains those
      // serves; it does not stop the filter from hiding them.
      const filterHidden = shelfCards.length === 0 && runHidden > 0;
      // REEA-1141 AC-4 — duplicate cards the SERVED document painted: fold the
      // same cumulative paint chain the StageAppend boundaries run over this
      // run's own stage snapshots (replay leads excluded — they are superseded
      // by the live shelf, not appended). The counter measures the real
      // inflation in `comparison_cards_total`, so depth can be corrected; it
      // is an aggregate integer only — no card ids, no query text.
      const paintedCards = await paintedShelfCardsAcrossStages(
        seededStaged.stages,
        query,
        1,
        country,
        showOutOfStock,
      );
      const duplicateCards = duplicateCardsOf(paintedCards);
      // REEA-1078/REEA-1148 — the recording clock was read on the bounded
      // allSettled resolution above: warm serves use the entry clock, cold
      // serves the capped collection clock. Never re-read here.
      // REEA-1237 (PM scope extension, v5 read) — the per-term aggregate is
      // recorded from the SAME serve facts as the counters, but only for
      // shopper serves: a QA/smoke probe's term must not dominate the Pareto.
      const botServe = isBotUserAgent(hint.userAgent);
      // REEA-1178 AC3/AC5 — the depth fold reads the SAME market view the
      // shelf speaks for (REEA-1177's marketViewScope: null on the "All"
      // selection), so a foreign accessory row can never become a comparison
      // lane on a Kuwait card.
      // REEA-1207 (Bet 7B Addition 2) — the DEFAULT surface is the Kuwait
      // market even when the viewer has not picked one ("All"): a Saudi-only
      // card is a cross-market card, not a comparison lane, and the counter
      // must record it that way. An explicit market selection still wins.
      const snapshotOutcome = pageSnap
        ? searchOutcomeFromSnapshot(pageSnap, shelfCards, marketViewScope(country) ?? HOME_MARKET)
        : { zeroOffers: false, offersByRetailer: {} };
      await recordSearchOutcome({
        ...snapshotOutcome,
        serveOutcome: serveOutcomeOf(served, convSnap),
        // REEA-1078 — serve kind from the collection layer (only it knows
        // whether a fresh memo answered with no fan-out).
        serveKind: seededStaged.serveKind,
        serveLatencyMs: Math.max(0, recordedMs - fanoutStartMs),
        adapterAttempts: adapterTelemetry.attempts,
        adapterFailures: adapterTelemetry.failures,
        // REEA-1267 — aggregate residual false-empty numerator (see above).
        filteredEmpty,
        // REEA-1267 — the REEA-1114 population (filter hid matches, escape
        // explained them) kept as its own aggregate.
        filterHidden,
        // REEA-1141 AC-4 — aggregate duplicate-card inflation (see above).
        duplicateCards,
        // REEA-1142 AC5 — cross-market offers on the served shelf.
        crossMarketOffers,
        // REEA-1200 (Bet 7C fold-in) — one boolean per serve: the shared
        // bot/health-check UA predicate already read for the render events.
        // It folds into the aggregate `bot_serves` counter, the ONE named
        // subtraction behind the clean CTR denominator (AC 7C-3/7C-4). The
        // UA string itself is never stored.
        botServe,
      });
      if (!botServe) {
        // REEA-1237 — one aggregate {term, count} row per week (no user id,
        // no session id, no per-serve row), marked with the same zero-offer
        // and filtered-empty facts so the Pareto fix can be targeted.
        await recordQueryTerm(query, {
          zeroOffer: snapshotOutcome.zeroOffers === true,
          filteredEmpty,
        });
      }
      // REEA-1078 S2 — the same telemetry feeds the per-lane daily evidence
      // the 7-day auto-retire rule reads. Behind the response (deferred
      // after() tail), aggregate-only, best-effort: a store failure leaves the
      // next serve to try again.
      await recordLaneAttempts({
        attempts: adapterTelemetry.attempts,
        failures: adapterTelemetry.failures,
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
  // one page slice. The primary/related split rides the SAME confidence
  // partition the client renders (REEA-964's stagedSections chain, mirrored
  // here on the pure lib pieces) — the metrics count what the page counts,
  // so zero_result_shown fires exactly when the page shows the empty state.
  after(async () => {
    if (!query || isBotUserAgent(hint.userAgent)) return;
    try {
      const snap = (await seededStaged.converged.then(
        (s) => s,
        () => null,
      )) ?? (await seededStaged.final.then(
        (s) => s,
        () => null,
      ));
      const sections = snap
        ? partitionByConfidence(
            query,
            filterProductsByStock(
              scopeProductsByMarket(snap.products, marketViewScope(country)),
              showOutOfStock,
              exactSkuKeep(query),
            ),
          )
        : { primary: [], related: [] };
      const events = buildRenderEvents({
        queryId,
        query,
        primaryCount: sections.primary.length,
        relatedCount: sections.related.length,
      });
      if (events.length > 0) await appendEvents(events);
    } catch {
      // Fire-and-forget (E8): a metrics write failure must never surface.
    }
  });

  return (
    <div
      className="results-viewport-reserve mx-auto w-full py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}
    >
      {/* REEA-1168 / REEA-1212 — Product/Offer JSON-LD for the offers this run
          actually painted. It folds the SAME staged promises ResultsClient
          paints through the renderer's own paint chain (no second fan-out, no
          client fetch, no admission change); the shell/heading flushes first
          and the script lands in the served document when the run finalizes.
          Empty when nothing is visible. */}
      <Suspense fallback={null}>
        <ResultsStructuredData
          stages={seededStaged.stages}
          query={query}
          country={country}
          locale={locale}
          nowMs={renderStartMs}
          page={page}
          showOutOfStock={showOutOfStock}
        />
      </Suspense>
      {/* REEA-1237 — the shopper CTR basis: one client page-view beacon per
          served results page, keyed on this render's per-query random id so a
          serve counts exactly once and a new render (new query / refresh)
          counts again. The server records `searches` only when a query is
          present, so the beacon mirrors that population. Renders nothing. */}
      {query ? <ResultsPageViewBeacon serveKey={queryId} /> : null}
      {/* REEA-965 — the per-query id rides the committed REEA-964 props seam:
          click events client-side join the same query execution's server-side
          search_performed through this value (FR-3.1). */}
      <ResultsClient
        query={query}
        page={page}
        country={country}
        showOutOfStock={showOutOfStock}
        locale={locale}
        stages={seededStaged.stages}
        renderStartMs={renderStartMs}
        queryId={queryId}
        unreachableLanes={unreachableLanes}
        shareOrigin={siteOrigin()}
      />
    </div>
  );
}
