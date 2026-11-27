"use client";

import { Component, Suspense, useEffect, useMemo, useRef, useState, use, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import FilterBar from "@/components/FilterBar";
import { StatusLegend } from "@/components/OfferStatus";
import ProductResultCard from "@/components/ProductResultCard";
import { searchProducts } from "@/lib/search";
import { sanitizePage, sanitizeSearchQuery } from "@/lib/search-params";
import { bestBadgeIndex, recallShowOutOfStock, rememberShowOutOfStock, sanitizeShowOutOfStock, sanitizeStockParam } from "@/lib/stock";
import {
  buildResultsHref,
  countryFromAcceptLanguage,
  recallCountry,
  rememberCountry,
  sanitizeMarket,
  type CountryCode,
} from "@/lib/country";
import {
  emptyMatchCase,
  hiddenMatchReport,
  type HiddenFilter,
} from "@/lib/hidden-matches";
import { trackEvents } from "@/lib/telemetry";
import {
  buildOfferRenderedEvents,
  buildRelatedClick,
  priceSanityStatusOf,
  type RenderedOffer,
} from "@/lib/metrics-events";
import { HeadingGhost, SkeletonCard, StampGhost, coverageLhTier } from "@/components/SkeletonSlots";
import { PRODUCTS } from "@/lib/feed";
import { realCouponsFor } from "@/lib/price-composition";
import { resultsShelfCards, resultsShelfSections, shelfSectionsFromProducts, RESULTS_PAGE_SIZE, CATEGORY_SHELF_CARDS, freshCardsForFlush, paintedIdsAfter, preferRicherSnapshot, shelfCardBudget } from "@/lib/results-shelf";
// REEA-1201 (Bet 7A-2) — the honest shelf's pure decisions: the in-scope count
// plural ladder and the thin-shelf test (same comparison-merchant count the
// card basis prints, so the page line can never contradict a card).
// REEA-1261 — the exact-model ladder and card set, so a brand+model query
// counts only the cards that answer the shopper's exact product.
import {
  exactModelCardsOf,
  exactModelCountTemplate,
  exactModelOnlyOutsideMarket,
  inScopeCountTemplate,
  isExactModelQuery,
  isThinShelf,
} from "@/lib/shelf-honesty";
import { formatPrice, sortOffers } from "@/lib/format";
import {
  HOME_MARKET,
  marketName,
  marketViewScope,
  sortOffersByMarket,
} from "@/lib/market";
import { merchantMarketCode } from "@/lib/collect/coverage";
import SearchForm from "@/components/SearchForm";
import { coverageParts, type LiveSearchResult } from "@/lib/collect/coverage";
import { markLiveRefresh, withRefreshBypass } from "@/lib/query-cache";
import { collectedAgeLabel, clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";
// REEA-1218 (Bet 8) — the static AR↔EN lexicon is browser-safe (no I/O); the
// results surface reads it only for the substitution line and the Arabic
// empty-state suggestions, so the lexicon ships as one static asset (AC-7).
import { ARABIC_EMPTY_SUGGESTIONS, arabicQueryAlias } from "@/lib/arabic-lexicon";
// REEA-1247 — nearest in-market recovery for the zero-offer page: pure, live
// from the run's own snapshot products, and never a fabricated offer.
import { nearestMatches } from "@/lib/zero-recovery";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-114: the results surface renders EXACTLY what the server collected at
 * query time (see src/app/results/page.tsx) — offers/titles/coupons/stock and
 * the freshness chips all ride on the passed-in products. No client-side
 * fallback array: hydration reuses the served data; a new query re-runs the
 * server collection through the router.
 *
 * REEA-178: with a staged run (`stages`) the same live collection streams —
 * each adapter flush appends its merged-so-far cards inside its own Suspense
 * boundary, so the first price paints while slower adapters are still in
 * flight. Appends never reorder already-visible cards; once every stage has
 * settled the view converges onto the exact full-ranked snapshot the blocking
 * path produced (shared final render path). Country/stock selections are
 * applied per snapshot before slicing, same rules as the plain path.
 */

const PAGE_SIZE = RESULTS_PAGE_SIZE;

/* Brief v4 loading/error states come from app/results/loading.tsx and the
   boundary below — keep the markup identical to the former in-component
   versions (Theme v1 §3.5, Brief v4). */
class ResultsErrorBoundary extends Component<
  { children: ReactNode; locale?: Locale },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      const t = getStrings(this.props.locale ?? clientLocale());
      return (
        <div className="rc-error-state" role="alert">
          <svg className="icon" width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6M12 17h.01" />
          </svg>
          <h2>{t.errorRetailersTitle}</h2>
          <p>{t.errorRetailersBody}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-primary focusable min-h-11 px-4"
          >
            {t.tryAgain}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* Brief v4 loading state: card-shaped ghosts with sheen + the slim amber
   pulse bar carrying the "checking stores" label — never a blank area.
   REEA-224 item 2: ghosts + heading slot mirror the real geometry; REEA-756
   adds the named per-retailer row slots. The geometry lives in the shared
   SkeletonSlots module so this streamed fallback, the route flash in
   results/loading.tsx, and the append blocks' reserves stay byte-identical
   across all three sites. */

export function LoadingFallback({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  // REEA-447 R1 — busy state on the collecting rail: aria-busy rides while
  // the partial is still collecting and comes off once the shell has settled
  // (same grammar as CollectionPulse's aria-busy={!settled} on the product
  // panel). When the staged content lands, the boundary swap removes the
  // container — and with it the attribute — so the busy signal never outlives
  // the collection it describes.
  const [isDone, setIsDone] = useState(false);
  useEffect(() => {
    // Deferred one tick so the settling flip never re-renders synchronously
    // inside the mount commit (cascading-render guard).
    queueMicrotask(() => setIsDone(true));
  }, []);
  return (
    <div className="space-y-4">
      <div className="pulse-bar" aria-hidden aria-busy={isDone ? undefined : true}>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        {t.checkingStores}
      </p>
      {/* REEA-224 identical-markup rule: heading/stamp reserves + named-slot
          card ghosts come from the shared SkeletonSlots geometry; REEA-778
          passes the locale so the coverage-line reserve rides its lh tier. */}
      <HeadingGhost />
      <StampGhost locale={locale} />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

/* REEA-964 FR-1 — the honest empty state. Copy is SPEC-PINNED (FR-1.1):
   heading exactly "No match found" (do not reword without PM sign-off), a
   sub-line suggesting rephrasing, then the THREE static editorially chosen
   example queries rendered as pills. The failed query lives in the pre-filled
   retry input (FR-1.2), not in the heading. REEA-437's tries line stays — a
   zero answer names what the live run searched. Supersedes the REEA-281
   live-suggestion pill row: a loosely-related suggestion must never
   masquerade as an onward result.
   E6: when the run's notes show the merchants ERRORED (zero offers because
   the stores didn't answer), the card says so instead of implying a no-match
   — honesty cuts both ways.
   REEA-1114 AC1/AC2 — filter-aware: a zero visible set that an ACTIVE filter
   hid is case (b). It names the filter and the count and offers the one-tap
   reveal; the spelling/broader-term copy is reserved for a genuine no-match
   (a) and the outage copy for a failed collection (c). Never a dead end while
   we hold the rows. */
function EmptyState({
  query,
  unavailable,
  country,
  locale,
  tries,
  hidden,
  onReveal,
}: {
  query: string;
  /** E6 — zero offers because the adapters failed, not an empty shelf. */
  unavailable?: boolean;
  country: CountryCode | null;
  locale?: Locale;
  /** REEA-437 AC-2 — the query forms the live run issued before declaring
   *  empty (whole query, then the trimmed-token widening), named on the card
   *  so a zero answer states what was tried instead of just saying "none". */
  tries?: string[];
  /** REEA-1114 AC1 — the active filter that hid ≥1 confident match. */
  hidden?: { filter: HiddenFilter; count: number } | null;
  /** REEA-1114 AC4 — reveal in place (client selection), query kept. */
  onReveal?: () => void;
}) {
  const resolvedLocale = locale ?? clientLocale();
  const t = getStrings(resolvedLocale);
  const filterLabel = hidden
    ? hidden.filter === "stock"
      ? t.inStock
      : countryLabel(country, t)
    : "";
  // REEA-1218 AC-4 — the Arabic empty state's three suggestions come from the
  // same curated lexicon the matcher uses (غسالة / لابتوب / بانادول), not from
  // generic English examples. EN keeps its shipped FR-1.1 pills.
  const suggestions =
    resolvedLocale === "ar"
      ? ARABIC_EMPTY_SUGGESTIONS
      : [t.emptyExample1, t.emptyExample2, t.emptyExample3];
  return (
    <div
      className="result-card empty-state rc-empty mx-auto w-full max-w-xl"
      data-empty-state="true"
      data-empty-case={hidden ? "b" : unavailable ? "c" : "a"}
    >
      <svg className="icon" width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <path d="M3 9.5 5.5 4h13L21 9.5V20H3V9.5Z" />
        <path d="M3 9.5h18M8.5 13.5h7" />
      </svg>
      {hidden ? (
        <>
          {/* AC1 — the count and the filter are the story; the query is fine. */}
          <h2 data-empty-hidden="true">
            {fill(t.emptyHiddenTitle, {
              n: hidden.count,
              unit: hidden.count === 1 ? t.matchOne : t.matchMany,
              filter: filterLabel,
            })}
          </h2>
          <p>{fill(t.emptyHiddenBody, { filter: filterLabel })}</p>
          <button
            type="button"
            className="btn-primary focusable min-h-11 px-4"
            data-empty-reveal={hidden.filter}
            onClick={onReveal}
          >
            {hidden.filter === "stock" ? t.emptyShowOutOfStock : t.emptyShowAllCountries}
          </button>
        </>
      ) : unavailable ? (
        <>
          {/* REEA-1096 D11 — one story per state. A collection failure says
              "The stores didn't answer" and never claims a no-match. */}
          <h2>{t.emptyUnavailableTitle}</h2>
          <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>{t.emptyUnavailable}</p>
        </>
      ) : (
        <>
          <h2>{t.emptyTitle}</h2>
          <p>{t.emptyBody}</p>
          <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>{t.emptyRetailersAsked}</p>
        </>
      )}
      {tries && tries.length > 0 ? (
        <p className="mt-2" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {fill(t.triedForms, { tries: tries.join('”, “') })}
        </p>
      ) : null}
      {/* REEA-1114 — the example pills answer "what should I type instead?".
          A filter-hidden zero does not ask that question, so case (b) drops
          them; the reveal action is the onward path. */}
      {hidden ? null : (
        <div className="mt-4 flex flex-wrap gap-2" data-empty-suggestions="true">
          {suggestions.map((q) => (
            <Link key={q} href={buildResultsHref(q, 1, country)} className="query-pill query-pill-on-light">
              {q}
            </Link>
          ))}
        </div>
      )}
      {/* FR-1.2 — the failed query pre-filled; retry is one keystroke away.
          mt-6 (REEA-983): 24px puts the retry form on the space scale as the
          terminal block of the card, one step past the pills. */}
      <div className="mt-6">
        <SearchForm defaultValue={query} country={country} locale={locale} />
      </div>
    </div>
  );
}

/**
 * REEA-1218 AC-3 — the explicit Arabic substitution line. When an Arabic query
 * is served under its curated Latin alias (the same alias the live fan-out is
 * dispatched under), the shelf names both spellings instead of silently
 * substituting. The copy is Arabic by AC-3 even on an English-chrome view,
 * because the line is about the shopper's Arabic query.
 */
function AliasSubstitutionLine({ query }: { query: string }) {
  const alias = arabicQueryAlias(query);
  if (!alias) return null;
  const t = getStrings("ar");
  return (
    <p
      data-alias-substitution="true"
      data-alias-from={alias.from}
      data-alias-to={alias.to}
      className="mt-2"
      style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}
    >
      {fill(t.aliasSubstitution, { alias: alias.to, query: alias.from })}
    </p>
  );
}

/** REEA-1096 D11 — a collection FAILURE is "no retailer answered" (every note
 *  errored, or there are no notes at all). One errored lane among answering
 *  ones is a partial response, not an outage: that empty state still says
 *  "No match found" and drops the outage line. */
function collectionFailed(notes: LiveSearchResult["notes"]): boolean {
  return notes.length > 0 && notes.every((n) => typeof n.error === "string");
}

/* REEA-965 — map one rendered card to its offer-metrics facts (FR-3.3's
   offer_rendered/coupon_hit unit). The retailer is the merchant whose offer
   LEADS the card — the same sortOffers order the rows render in, so the
   attributed retailer is the one the card's CTA acts on; priceSanityStatus
   rides R1's per-offer annotation (null when the cohort pass never ran). */
function offerMetricsFor(
  products: readonly NormalizedProduct[],
  country: CountryCode | null,
): RenderedOffer[] {
  // REEA-1142 — the attributed retailer is the card's LEAD offer in the same
  // market-scoped order the rows render in, so a converted cross-market row
  // never impersonates the local lead in the funnel.
  const scope = marketViewScope(country);
  return products.map((p) => {
    const lead = sortOffersByMarket(p.offers, p.coupons[0] ?? null, scope)[0];
    return {
      offerId: p.productId,
      retailer: lead?.merchant ?? "unknown",
      // REEA-1177 AC 6a-3 — a derived was-price entry is not a coupon.
      hasCoupon: realCouponsFor(p.coupons, p.offers).length > 0,
      priceSanityStatus: priceSanityStatusOf(lead?.sanity),
    };
  });
}

/* REEA-964 FR-2 — the related-accessories band: the SECOND section of the
   results page, always clearly labeled "not an exact match", capped at
   RELATED_CAP (6), visually subordinate (compact rows, muted band styling —
   visual polish belongs to the Graphic Designer). Never renders as peer
   cards inside primary results.
   REEA-965 — a band-item click fires the spec-table `related_click`
   (queryId, offerId, retailer) fire-and-forget; the retailer is the item's
   cheapest-offer merchant and the event simply doesn't fire when the item
   carries no offer (no invented retailer — data minimization). */
function RelatedBand({
  items,
  locale,
  queryId,
}: {
  items: NormalizedProduct[];
  locale?: Locale;
  queryId?: string;
}) {
  const t = getStrings(locale ?? clientLocale());
  if (items.length === 0) return null;
  return (
    <section
      className="related-band"
      aria-label={t.relatedNotExactLabel}
      data-related-band="true"
      style={{ marginTop: "var(--rc-space-8)" }}
    >
      <h2 className="related-band-title" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
        {t.relatedNotExactLabel}
      </h2>
      <ul className="related-band-list mt-2">
        {items.map((p) => {
          const priced = [...p.offers].sort((a, b) => a.price - b.price)[0];
          return (
            <li key={p.productId} className="related-item" data-related-item="true">
              <span className="related-chip">{t.relatedChip}</span>
              <Link
                href={`/product/${encodeURIComponent(p.productId)}`}
                className="related-item-link focusable"
                aria-label={`${t.relatedChip}: ${p.title}`}
                onClick={() => {
                  // REEA-965 AC-9 — fire-and-forget; navigation is not delayed.
                  if (!queryId || !priced) return;
                  trackEvents([
                    buildRelatedClick({ queryId, offerId: p.productId, retailer: priced.merchant }),
                  ]);
                }}
              >
                <span className="related-item-title">{p.title}</span>
                {priced ? (
                  <span className="related-item-meta" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
                    {t.fromWord} {formatPrice(priced.price, priced.currency)}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* REEA-1201 AC 7b-2 — the labelled accessory band. It renders ONLY the cards
   the payload scoped `accessory`, always BELOW the primary shelf, and reuses
   the related band's compact-row markup/classes so no new visual direction or
   component library enters the page. Accessory rows are not primary results;
   their clicks ride the same `related_click` event as the related band. */
function AccessoryBand({
  items,
  locale,
  queryId,
}: {
  items: NormalizedProduct[];
  locale?: Locale;
  queryId?: string;
}) {
  const t = getStrings(locale ?? clientLocale());
  if (items.length === 0) return null;
  return (
    <section
      className="related-band accessory-band"
      aria-label={t.accessoryBandAria}
      data-accessory-band="true"
      style={{ marginTop: "var(--rc-space-8)" }}
    >
      <h2 className="related-band-title" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
        {t.accessoryBandLabel}
      </h2>
      <ul className="related-band-list mt-2">
        {items.map((p) => {
          const priced = [...p.offers].sort((a, b) => a.price - b.price)[0];
          return (
            <li key={p.productId} className="related-item" data-accessory-item="true">
              <span className="related-chip">{t.accessoryChip}</span>
              <Link
                href={`/product/${encodeURIComponent(p.productId)}`}
                className="related-item-link focusable"
                aria-label={`${t.accessoryChip}: ${p.title}`}
                onClick={() => {
                  if (!queryId || !priced) return;
                  trackEvents([
                    buildRelatedClick({ queryId, offerId: p.productId, retailer: priced.merchant }),
                  ]);
                }}
              >
                <span className="related-item-title">{p.title}</span>
                {priced ? (
                  <span className="related-item-meta" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
                    {t.fromWord} {formatPrice(priced.price, priced.currency)}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * REEA-1247 AC3/AC4/AC5 — the zero-offer recovery surface. It replaces the old
 * "Accessories for this product" band on a page that has no product: a zero
 * result cannot own accessories, and padding the last impression with a
 * children's book and a games console is the defect this ticket names.
 *
 * Only REAL live offers from this run's own snapshot are eligible. Every item
 * must carry the shopper's matched query term (the label names it) and at least
 * one in-market (Kuwait) offer, so the band never claims a Kuwait match that
 * has no Kuwait price. When nothing is in market the page says "Not stocked in
 * Kuwait" and keeps the foreign offers in a separate, clearly-labelled band.
 * Capped at RECOVERY_CAP; deterministic order from the snapshot alone.
 */
function ZeroRecovery({
  products,
  query,
  locale,
  queryId,
}: {
  /** The selection-filtered non-primary cards of the run (related + accessory). */
  products: NormalizedProduct[];
  query: string;
  locale?: Locale;
  queryId?: string;
}) {
  const l = locale ?? clientLocale();
  const t = getStrings(l);
  const { inMarket, foreign } = nearestMatches(query, products);
  if (inMarket.length === 0 && foreign.length === 0) return null;
  return (
    <>
      {inMarket.length > 0 ? (
        <section
          className="related-band recovery-band"
          aria-label={t.youMightAlsoLike}
          data-recovery-band="true"
          style={{ marginTop: "var(--rc-space-8)" }}
        >
          <h2 className="related-band-title" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
            {t.youMightAlsoLike}
          </h2>
          <ul className="related-band-list mt-2">
            {inMarket.map((item) => (
              <li
                key={item.product.productId}
                className="related-item"
                data-recovery-item="true"
                data-recovery-term={item.matchedTerm}
                data-recovery-market="KW"
              >
                <span className="related-chip">
                  {fill(t.closestMatchChip, { term: item.matchedTerm })}
                </span>
                <Link
                  href={`/product/${encodeURIComponent(item.product.productId)}`}
                  className="related-item-link focusable"
                  aria-label={`${fill(t.closestMatchChip, { term: item.matchedTerm })}: ${item.product.title}`}
                  onClick={() => {
                    if (!queryId) return;
                    trackEvents([
                      buildRelatedClick({
                        queryId,
                        offerId: item.product.productId,
                        retailer: item.offers[0]?.merchant ?? "unknown",
                      }),
                    ]);
                  }}
                >
                  <span className="related-item-title">{item.product.title}</span>
                  <span className="related-item-meta" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
                    {t.fromWord} {formatPrice(item.price, item.currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p
          className="not-stocked-line"
          data-not-stocked="true"
          style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", marginTop: "var(--rc-space-4)" }}
        >
          {t.notStockedInKuwait}
        </p>
      )}
      {foreign.length > 0 ? (
        <section
          className="related-band foreign-band"
          aria-label={t.foreignAlternativesLabel}
          data-foreign-band="true"
          style={{ marginTop: "var(--rc-space-8)" }}
        >
          <h2 className="related-band-title" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
            {t.foreignAlternativesLabel}
          </h2>
          <ul className="related-band-list mt-2">
            {foreign.map((item) => (
              <li
                key={item.product.productId}
                className="related-item"
                data-foreign-item="true"
                data-recovery-term={item.matchedTerm}
                data-market={item.market}
              >
                <span className="related-chip">{marketName(item.market, l)}</span>
                <Link
                  href={`/product/${encodeURIComponent(item.product.productId)}`}
                  className="related-item-link focusable"
                  aria-label={`${marketName(item.market, l)}: ${item.product.title}`}
                  onClick={() => {
                    if (!queryId) return;
                    trackEvents([
                      buildRelatedClick({
                        queryId,
                        offerId: item.product.productId,
                        retailer: item.offers[0]?.merchant ?? "unknown",
                      }),
                    ]);
                  }}
                >
                  <span className="related-item-title">{item.product.title}</span>
                  <span className="related-item-meta" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
                    {t.fromWord} {formatPrice(item.price, item.currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/* REEA-1201 AC 7b-1 — the honest in-scope count line. `count` is the number of
   primary-scope cards the shelf actually renders (the payload's own scope
   decision, see results-shelf.ts), never the padded slot count. The query is
   bidi-isolated so the Arabic sentence keeps its order. */
function InScopeCountLine({
  count,
  query,
  locale,
}: {
  count: number;
  query: string;
  locale?: Locale;
}) {
  const l = locale ?? clientLocale();
  const t = getStrings(l);
  const template = inScopeCountTemplate(l, count);
  const [before, after] = template.split("{q}");
  return (
    <p
      className="in-scope-count"
      data-in-scope-count="true"
      data-in-scope-total={count}
      style={{ font: "var(--rc-text-body)", color: "var(--rc-ink)", marginTop: "var(--rc-space-3)" }}
    >
      {fill(before, { n: count })}
      <bdi>{query}</bdi>
      {fill(after ?? "", { n: count })}
    </p>
  );
}

/* REEA-1261 AC-2 — the exact-model count line. On a brand+model query the
   shopper named ONE product, so the page counts the exact-model cards the
   shelf actually renders (never the neighbours that share a token) and says
   when every one of them is carried outside the selected market. The number
   and the shelf read the SAME predicate (carriesExactModel), so the sentence
   cannot contradict the cards below it. */
function ExactModelCountLine({
  count,
  market,
  noneInMarket,
  locale,
}: {
  count: number;
  market: string;
  noneInMarket: boolean;
  locale?: Locale;
}) {
  const l = locale ?? clientLocale();
  const template = exactModelCountTemplate(l, count, noneInMarket);
  return (
    <p
      className="in-scope-count exact-model-count"
      data-exact-model-count="true"
      data-exact-model-total={count}
      data-exact-model-none-in-market={noneInMarket ? "true" : "false"}
      style={{ font: "var(--rc-text-body)", color: "var(--rc-ink)", marginTop: "var(--rc-space-3)" }}
    >
      {fill(template, { n: count, market })}
    </p>
  );
}

/* REEA-1201 AC 7b-3 — thin-shelf honesty: when every rendered card carries one
   in-market retailer, the page says no cross-retailer match was found instead
   of letting the shelf imply a comparison. */
function ThinShelfLine({ query, locale }: { query: string; locale?: Locale }) {
  const l = locale ?? clientLocale();
  const t = getStrings(l);
  const [before, after] = t.thinShelfLine.split("{q}");
  return (
    <p
      className="thin-shelf-line"
      data-thin-shelf="true"
      role="note"
      style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", marginTop: "var(--rc-space-2)" }}
    >
      {before}
      <bdi>{query}</bdi>
      {after ?? ""}
    </p>
  );
}

/* Design v3 §5.2 grid: single-column list, two columns only ≥1280px.
   minmax(0,1fr) tracks keep long product titles from widening the grid past
   the viewport at 375px (smoke step 5). Shared by the staged and plain paths
   so both converge on identical markup.
   REEA-964 FR-2.1 — the grid renders ONLY confident matches, inside the
   primary <section> (distinct role/heading in the DOM so the two-section
   separation is machine-checkable); below-threshold rows ride the labeled
   RelatedBand instead (the REEA-189 Devices/Accessories stacked grids —
   which still let an accessory peer with the device at full card size — are
   superseded by the confidence partition). */
function ResultsGrid({
  products,
  query,
  page,
  country,
  showOutOfStock,
  renderStartMs,
  locale,
  kuwaitBatchPending,
  kuwaitPendingStatus,
  queryId,
  shareOrigin,
}: {
  products: NormalizedProduct[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
  /** REEA-835/847 — the two facts the lead card's flag slot decides on (see
   *  ProductResultCard): the Kuwait batch may still land for this render, and
   *  whether the rendered set carries zero Kuwait-primary offers. Absent
   *  batch-pending = settled rules, byte-for-byte. */
  kuwaitBatchPending?: boolean;
  kuwaitPendingStatus?: boolean;
  /** REEA-965 — per-query metrics id, threaded to the cards' click events. */
  queryId?: string;
  /** REEA-1255 — server-resolved origin for the card share's PDP URL. */
  shareOrigin?: string;
}) {
  const t = getStrings(locale ?? clientLocale());
  // REEA-1142 AC2 — the single "Best price" badge rests on a LOCAL offer only.
  const bestAt = bestBadgeIndex(products, marketViewScope(country));
  return (
    <section aria-label={t.primaryResultsAria} data-primary-section="true">
      <div
        className="rc-shelf"
        style={{ marginTop: "var(--rc-space-8)" }}
      >
        {products.map((p, i) => (
          <ProductResultCard
            key={p.productId}
            product={p}
            isBest={i === bestAt}
            kuwaitBatchPending={kuwaitBatchPending} kuwaitPendingStatus={kuwaitPendingStatus}
            query={query}
            rank={(page - 1) * PAGE_SIZE + i}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={renderStartMs}
            cascadeIndex={i}
            queryId={queryId}
            shareOrigin={shareOrigin}
          />
        ))}
      </div>
    </section>
  );
}

export default function ResultsClient(props: {
  /** Server-collected live set (REEA-114). Absent props fall back to the
   *  client-side feed read so tests and the static-export host still work. */
  query?: string;
  page?: number;
  products?: NormalizedProduct[];
  suggestions?: NormalizedProduct[];
  /** REEA-170 country selection resolved server-side from `?c=` (null = All). */
  country?: CountryCode | null;
  /** REEA-186 stock selection resolved server-side from `?oos=` (false = hide). */
  showOutOfStock?: boolean;
  /** REEA-178 staged live collection — one promise per adapter flush. */
  stages?: Promise<LiveSearchResult>[];
  /** REEA-283 server-render clock. Serialized into the streamed props so
   *  hydration reuses the SAME value the SSR freshness digit was computed
   *  from — no Date.now() recompute on either pass, no mismatch. */
  renderStartMs?: number;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /** REEA-965 — per-query-execution id from the server render; consumed by
   *  the R2 instrumentation (search_performed / zero_result_shown). */
  queryId?: string;
  /** REEA-1078 AC9 — merchants whose retailer zone is recorded unreachable
   *  from this egress. The coverage sentence names them as unreachable
   *  instead of letting a silent zero read as "we don't stock it". */
  unreachableLanes?: readonly string[];
  /** REEA-1255 — server-resolved site origin for the WhatsApp share URL
   *  (lib/site-origin.ts). Passed down, never read from the client env. */
  shareOrigin?: string;
}) {
  return (
    <Suspense fallback={<LoadingFallback locale={props.locale} />}>
      <ResultsInner {...props} />
    </Suspense>
  );
}

function SelectionRow({
  country,
  showOutOfStock,
  onSelectCountry,
  onToggleStock,
  onRefresh,
  locale,
  hiddenByStock,
  hiddenByCountry,
}: {
  country: CountryCode | null;
  showOutOfStock: boolean;
  onSelectCountry: (code: CountryCode | null) => void;
  onToggleStock: (next: boolean) => void;
  onRefresh: () => void;
  locale?: Locale;
  /** REEA-1114 AC3 — the active filter's hidden-match count for the chip. */
  hiddenByStock?: number;
  hiddenByCountry?: number;
}) {
  // REEA-1069 — the Direction A filter/market bar: six 44px controls, two
  // rows at 375, selected state with a check glyph + aria-pressed. The
  // controls filter the already-loaded live payload IN PLACE (REEA-291 AC4);
  // Refresh is the one explicit action that re-runs the collection.
  return (
    <FilterBar
      country={country}
      showOutOfStock={showOutOfStock}
      onSelectCountry={onSelectCountry}
      onToggleStock={onToggleStock}
      onRefresh={onRefresh}
      locale={locale}
      hiddenByStock={hiddenByStock}
      hiddenByCountry={hiddenByCountry}
    />
  );
}

/* REEA-1099 — the shelf card population lives in ONE shared definition
   (src/lib/results-shelf.ts) so the renderer and the comparison-depth counter
   can never drift apart. Selections apply BEFORE the confidence partition,
   per snapshot — same chain the plain path runs, so staged and converged
   views agree. REEA-964: the partition splits the filtered set into primary
   (confident) and related (below threshold, capped) — the page slice applies
   to the PRIMARY list only; the related band is capped by the partition
   itself, on every page. REEA-822: the exact-SKU keep-predicate rides the
   stock stage so the code-matched card survives the default OOS card-level
   drop (its all-OOS offer set renders honestly as out-of-stock instead of
   erasing the lead into a fake zero). */
const stagedSections = resultsShelfSections;
const stagedView = resultsShelfCards;

/* Design v3 grid inside one streaming block (see StageAppend). */
const GRID_CLASS = "rc-shelf";

/* REEA-970 — pending-window ghost for the streamed FIRST-flush boundary.
   Root cause of the QA adverse finding on REEA-759 criterion 3: the REEA-756
   named per-retailer slot ghosts shipped only inside LoadingFallback (the
   outer Suspense fallback) and the results/loading.tsx route flash — but on
   the live streaming path ResultsInner renders synchronously (it never
   suspends on the stages), so the outer fallback is unreachable, and the
   index-0 StageAppend boundary carried `fallback={null}`. The card region
   therefore painted BLANK while the first adapter flush was in flight; the
   only pending paint was the anonymous heading slot. The ghost composes the
   SAME shared SkeletonSlots geometry (SkeletonCard's named slots) on the
   settled grid's own class, so the pending region shows the retailers' named
   slots instead of a blank band, and the first flush swaps INTO the reserved
   geometry (REEA-756 swap-in-place rule) instead of appearing over nothing.
   Two ghosts mirror the xl two-column settled grid; below xl they stack
   one-per-row exactly like real cards. aria-hidden: presentation chrome,
   never announced content. */
function StagedGridGhost() {
  return (
    <div className={GRID_CLASS} aria-hidden>
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}


function FlushBlock(props: {
  products: NormalizedProduct[];
  bestAt: number;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
  kuwaitBatchPending?: boolean;
  kuwaitPendingStatus?: boolean;
  /** REEA-965 — per-query metrics id (threaded via the StageAppend spread). */
  queryId?: string;
  /** REEA-1255 — server-resolved origin for the card share's PDP URL. */
  shareOrigin?: string;
}) {
  const { products, bestAt, query, page, country, showOutOfStock, renderStartMs, locale, kuwaitBatchPending, kuwaitPendingStatus } = props;
  if (products.length === 0) return null;
  // REEA-213: inside a participating block the badge rides the first
  // in-stock card of the final sorted order, never a later cheaper one.
  const badgeAt = bestAt < 0 ? -1 : bestBadgeIndex(products, marketViewScope(country));
  return (
    <div>
      <div className={GRID_CLASS}>
        {products.map((p, i) => (
          <ProductResultCard
            key={p.productId}
            product={p}
            isBest={i === badgeAt}
            kuwaitBatchPending={kuwaitBatchPending} kuwaitPendingStatus={kuwaitPendingStatus}
            query={query}
            rank={(page - 1) * PAGE_SIZE + i}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={renderStartMs}
            cascadeIndex={i}
            queryId={props.queryId}
            shareOrigin={props.shareOrigin}
          />
        ))}
      </div>
    </div>
  );
}

/* One boundary per adapter flush: renders only the cards NEW in this snapshot.
   A card whose id already appeared in ANY earlier painted flush keeps its slot
   and is not re-rendered (append-only over cumulative snapshots, AC-2).
   REEA-1141 — the baseline is CUMULATIVE, not the adjacent prior snapshot: an
   empty intermediate flush (an adapter that answered with no kept offers) used
   to reset the diff baseline, so the next flush re-rendered products already
   painted by the stale replay lead. A replay snapshot (cached stale-while-
   revalidate / shared-layer warm, `snap.replay`) is not painted at all: the
   live stage paints the newest version of the same products, so the fresh
   shelf REPLACES the stale one instead of appending beside it.
   All values derive purely from the snapshot pair — no mutable accumulators —
   so flush order, hydration, and re-renders land on identical markup.

   REEA-964: flushes render CONFIDENT (primary) cards only; the related band
   is a separate final-stage boundary (StageEmptyState below), so a
   below-threshold row can never append into the primary flow mid-stream. */
const EMPTY_PAINTED_IDS: ReadonlySet<string> = new Set<string>();

function StageAppend(props: {
  stages: Promise<LiveSearchResult>[];
  index: number;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
  /** REEA-965 — per-query metrics id; rides the {...props} spread into FlushBlock. */
  queryId?: string;
  /** REEA-1255 — server-resolved origin for the card share's PDP URL; rides
   *  the same spread into FlushBlock. */
  shareOrigin?: string;
  /** REEA-1141 — productIds painted by every earlier flush in this chain. */
  paintedIds?: ReadonlySet<string>;
}) {
  const { stages, index, page, country, showOutOfStock } = props;
  const snap = use(stages[index]);
  const visible = stagedView(snap, props.query, page, country, showOutOfStock);
  const paintedIds = props.paintedIds ?? EMPTY_PAINTED_IDS;
  // REEA-1141 — a cached replay is superseded by the live fan-out running
  // behind this response; painting it would duplicate the live shelf. It
  // contributes no cards and does not claim ids in the baseline, so the live
  // stage paints the newest version of those products (AC-3).
  const replay = snap.replay === true;
  // REEA-1207 — the same cumulative budget the metrics fold uses, so the
  // painted shelf and the counter can never describe different populations.
  // REEA-1238 — a category shelf's intermediate flush is comparison-only and
  // the final flush spends the remaining slots on the comparison-led shelf;
  // the fold (paintedShelfCardsAcrossStages) applies the identical policy.
  const budget = shelfCardBudget(props.query);
  // REEA-1238 — comparison-first for every query class; the final flush may
  // add one single on a category shelf and two on the wider exact-model page.
  const fresh = freshCardsForFlush(visible, paintedIds, replay, budget, {
    comparisonFirst: true,
    finalFlush: index === stages.length - 1,
    singleTail: budget === CATEGORY_SHELF_CARDS ? 1 : 2,
  });
  const nextPaintedIds = paintedIdsAfter(paintedIds, fresh);
  // REEA-222: badge ownership follows the first flush that actually RENDERS
  // cards, not index 0 blindly. When the earliest snapshots are empty under
  // the country/stock selections (or a replay that paints nothing), the whole
  // page used to render without any Best-price badge.
  const badgeOwner = fresh.length > 0 && paintedIds.size === 0;
  // REEA-835/847 — the Kuwait batch is still pending for THIS render when
  // more answers may still land: any intermediate flush (later stages are
  // still streaming), or a finalized-at-budget snapshot (`settled === false`,
  // whose follow-up feed may still fold Kuwait rows in). A settled converged
  // snapshot keeps the current flag rules byte-for-byte (AC4) — if the four
  // Kuwait-primary merchants genuinely answered without offers, the Best-price
  // flag on the fallback offer is the honest settled state. Whether the flag
  // slot actually withholds is decided on the CARD (ProductResultCard): zero
  // Kuwait-primary offers rendered (the snapshot flag), OR the flagged offer
  // itself is non-KWD — a Kuwait-primary merchant answering does not make an
  // interim SAR/EGP lead a Kuwait best price (REEA-847 cold-query repro).
  const kuwaitBatchPending = index < stages.length - 1 || snap.settled === false;
  const kuwaitPendingStatus = snap.kuwaitPendingStatus === true;
  // REEA-1068 D3 — a first flush that landed empty used to leave the card
  // region BLANK until the final stage resolved (QA measured up to ~11 s on
  // `zzzzqqq`): the index-0 boundary swapped its named-slot ghost out for
  // nothing, and every later append boundary kept `fallback={null}`. While
  // NOTHING has painted and a later stage is still in flight, keep the same
  // named-slot ghost in the reserve, so the shopper sees "still checking"
  // geometry instead of an empty band until the honest empty state lands.
  const shelfStillEmpty = paintedIds.size === 0 && fresh.length === 0;
  const next = index + 1 < stages.length ? (
    <Suspense fallback={shelfStillEmpty ? <StagedGridGhost /> : null}>
      <StageAppend {...props} index={index + 1} paintedIds={nextPaintedIds} />
    </Suspense>
  ) : null;

  return (
    <>
      <FlushBlock products={fresh} bestAt={badgeOwner ? 0 : -1} kuwaitBatchPending={kuwaitBatchPending} kuwaitPendingStatus={kuwaitPendingStatus} {...props} />
      {next}
    </>
  );
}

function countryLabel(country: CountryCode | null, t: ReturnType<typeof getStrings>): string {
  if (country === "SA") return t.countrySA;
  if (country === "EG") return t.countryEG;
  return t.countryKW;
}

/* REEA-1069 — Direction A results heading (REEA-1055 §3, AC4).
   ONE h1 carrying the query echo (never the count), at --rc-text-h1
   (28/32px), deliberately smaller than the card price (32/40px): the price
   wins the hierarchy. The count and the live-collection stamp ride the meta
   subline below. The status legend sits once under this heading. */
function ResultsHead({
  query,
  country,
  locale,
  children,
}: {
  query: string;
  country: CountryCode | null;
  locale?: Locale;
  /** The hint slot sits DIRECTLY under the h1 (REEA-332 item 2). */
  children?: ReactNode;
}) {
  const t = getStrings(locale ?? clientLocale());
  const label = countryLabel(country, t);
  // The query is a bidi-isolated Latin/Arabic token inserted at the template's
  // {q} slot, so the Arabic sentence keeps its designed order
  // (أسعار iPhone 15 في الكويت) instead of a prepended echo.
  const [before, after] = t.resultsHeading.split("{q}");
  return (
    <div className="rc-results-head">
      <h1>
        {query ? (
          <>
            {before}
            <bdi>{query}</bdi>
            {(after ?? "").replace("{country}", label)}
          </>
        ) : (
          fill(t.resultsHeadingAll, { country: label })
        )}
      </h1>
      {children}
    </div>
  );
}

/* The honest-empty hint sits DIRECTLY under the h1 (REEA-332 item 2): one
   muted line naming the retry shape. It renders only once the answer is an
   honest zero — never while a finalized-at-budget snapshot may still deepen. */
function HintLine({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>{t.emptyHint}</p>;
}

function ResultsHint({
  stage,
  query,
  page,
  country,
  showOutOfStock,
  locale,
}: {
  stage: Promise<LiveSearchResult>;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
}) {
  const snap = use(stage);
  if (snap.settled === false) return null;
  const visible = stagedView(snap, query, page, country, showOutOfStock);
  if (visible.length > 0) return null;
  // REEA-1114 AC2 — "try a shorter phrase" is only true for a genuine
  // no-match (a). A filter-hidden zero (b) and an outage (c) have their own
  // story in the empty state; the hint must not contradict it.
  const hidden = hiddenMatchReport(snap.products, query, country, showOutOfStock);
  if (emptyMatchCase(hidden, collectionFailed(snap.notes)).kind !== "a") return null;
  return <HintLine locale={locale} />;
}

/* The meta subline under the heading: count + retailer offers + the live
   collection age. It streams with the final snapshot, while the h1 above is
   already on screen (design loading state: heading renders immediately, only
   the shelf is busy). */
function ResultsSubline({
  stage,
  query,
  page,
  country,
  showOutOfStock,
  renderStartMs,
  locale,
}: {
  stage: Promise<LiveSearchResult>;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
}) {
  const snap = use(stage);
  const visible = stagedView(snap, query, page, country, showOutOfStock);
  // REEA-1156 D11 — a zero-visible set still gets its real count line, even
  // while the snapshot is finalized-at-budget. The lone "." StampGhost used
  // to sit there through collection; the designed empty panel now renders
  // from the same zero state, so the meta line must say "0 results …
  // collected live just now" instead of an invisible placeholder.
  const offers = visible.reduce((n, p) => n + p.offers.length, 0);
  let newest = 0;
  for (const p of visible) for (const o of p.offers) {
    const ms = o.collectedAt ? Date.parse(o.collectedAt) : NaN;
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  // eslint-disable-next-line react-hooks/purity -- baked server clock; fallback only when absent.
  const ageSecs = newest > 0 ? Math.max(0, Math.floor(((renderStartMs ?? Date.now()) - newest) / 1000)) : 0;
  const t = getStrings(locale ?? clientLocale());
  const unit = visible.length === 1 ? t.resultsOne : t.resultsMany;
  const values = {
    n: visible.length,
    unit,
    offers,
    // REEA-1096 D8 — the subline already says "collected live" / `جُمعت مباشرة`,
    // so it takes the bare duration, never the "Checked/حُدِّث" sentence.
    age: ageSecs === 0 ? t.justNow : collectedAgeLabel(locale ?? clientLocale(), ageSecs),
  };
  const [before, after] = t.resultsSubline.split("{q}");
  return (
    <p className="rc-results-meta">
      {fill(before, values)}
      {locale === "ar" ? <bdi>{query || t.allProducts}</bdi> : query || t.allProducts}
      {fill(after ?? "", values)}
    </p>
  );
}

/* Settled form of the meta subline (converged/plain views already hold the
   visible set; the streamed form above resolves its own snapshot). */
function ResultsMeta({
  products,
  query,
  renderStartMs,
  locale,
}: {
  products: NormalizedProduct[];
  query: string;
  renderStartMs?: number;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const offers = products.reduce((n, p) => n + p.offers.length, 0);
  let newest = 0;
  for (const p of products) for (const o of p.offers) {
    const ms = o.collectedAt ? Date.parse(o.collectedAt) : NaN;
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  // eslint-disable-next-line react-hooks/purity -- baked server clock; fallback only when absent.
  const ageSecs = newest > 0 ? Math.max(0, Math.floor(((renderStartMs ?? Date.now()) - newest) / 1000)) : 0;
  const values = {
    n: products.length,
    unit: products.length === 1 ? t.resultsOne : t.resultsMany,
    offers,
    age: ageSecs === 0 ? t.justNow : collectedAgeLabel(locale ?? clientLocale(), ageSecs),
  };
  const [before, after] = t.resultsSubline.split("{q}");
  return (
    <p className="rc-results-meta">
      {fill(before, values)}
      {locale === "ar" ? <bdi>{query || t.allProducts}</bdi> : query || t.allProducts}
      {fill(after ?? "", values)}
    </p>
  );
}

/* REEA-290 — per-query coverage line: which retailers answered this search
   and which did not, stated in plain text right on the results page. The
   sentence derives from the SAME live notes that produced the visible offers
   (coverageLine), so a retailer named as missing is traceable to its own
   failed live fetch — never a static registry. Reads as a plain meta stamp
   like the loading label; spacing/typography polish belongs to the Graphic
   Designer. The streaming boundary rides the FINAL stage (the only snapshot
   where every in-scope retailer has settled), so the sentence describes the
   whole collection while earlier retailers' offers are already painted — a
   late or failed retailer only deepens the line, it never blanks the grid. */
/**
 * REEA-1096 D7 — render one coverage name group with each Latin retailer name
 * in `<bdi class="lat">` (unicode-bidi:isolate + dir=ltr from the .lat token).
 * The separators/summary text reproduce `summarizeNames` byte-for-byte, so the
 * sentence reads identically while bidi can no longer glue names together.
 */
function CoverageNames({ names, ar }: { names: string[]; ar: boolean }) {
  const max = 3;
  const shown = names.length > max ? names.slice(0, max) : names;
  const rest = names.length - shown.length;
  const out: ReactNode[] = [];
  shown.forEach((name, i) => {
    if (i > 0) {
      out.push(
        <span key={`sep-${i}`}>{ar ? " و" : i === shown.length - 1 && rest === 0 ? " and " : ", "}</span>,
      );
    }
    // REEA-1142 AC4 — a lane that answers from another market says so in the
    // coverage sentence ("Danube Home · Saudi Arabia"), so its rows are never
    // read as Kuwait coverage.
    const market = merchantMarketCode(name);
    const marketSuffix = market && market !== "KW" ? ` · ${marketName(market, ar ? "ar" : "en")}` : "";
    out.push(
      <bdi key={`name-${i}`} className="lat">
        {name}
        {marketSuffix ? <span className="rc-market-coverage">{marketSuffix}</span> : null}
      </bdi>,
    );
  });
  if (rest > 0) {
    out.push(<span key="rest">{ar ? ` و${rest} أخرى` : ` and ${rest} more`}</span>);
  }
  return <>{out}</>;
}

function CoverageLine({
  notes,
  products,
  query,
  locale,
  pendingStatus,
  onRefresh,
  unreachableLanes,
  shelfEmpty,
  exactModelCards,
  className,
}: {
  notes: LiveSearchResult["notes"];
  products: NormalizedProduct[];
  /** REEA-1143 — query shape only ("carries this exact model" wording); the
   *  sentence itself is counts + retailer names, never the query text. */
  query?: string;
  locale?: Locale;
  pendingStatus?: boolean;
  onRefresh?: () => void;
  /** REEA-1078 AC9 — merchants the reachability record names as blocked. */
  unreachableLanes?: readonly string[];
  /** REEA-1247 AC1/AC2 — the primary shelf renders zero offers, so the
   *  painted `products` set may still hold related-band rows that must not be
   *  named under "Prices from" or counted as "carry this". */
  shelfEmpty?: boolean;
  /** REEA-1261 AC-2 — the exact-model cards this shelf renders, so the
   *  "N carry this exact model" number can never exceed the cards that answer
   *  the shopper's product. Absent = the pre-change lane-based count. */
  exactModelCards?: number;
  className?: string;
}) {
  const parts = coverageParts(
    notes,
    locale,
    products,
    unreachableLanes,
    query,
    shelfEmpty,
    exactModelCards,
  );
  if (parts.length === 0 && !pendingStatus) return null;
  // REEA-778 — the settled sentence rides the SAME lh-tier box as its
  // StampGhost reserve (one shared deterministic box per locale tier): the
  // swap changes no height, so nothing below moves when the line lands.
  // REEA-793 B2 — has-status mode: the amber cached-chip pill rides the SAME
  // box, and the lh tier grows one step ONLY in this mode (CSS single-owner
  // tiers), so the normal pass stays byte-for-byte. The trailing token is
  // ONE real button — the sole interactive token in the line — and the
  // combined textContent reads byte-equal "…still loading — Refresh".
  const l = locale ?? clientLocale();
  return (
    <p
      className={`meta-stamp coverage-line${pendingStatus ? " has-status" : ""}${className ? " " + className : ""}`}
      style={{ color: "var(--rc-muted)", minHeight: `${coverageLhTier(locale)}lh` }}
    >
      {parts.length > 0 ? (
        <span className="rc-partial">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 7.8h.01" />
          </svg>
          <span>
            {/* REEA-1096 D7 — every Latin retailer name is a bdi.lat isolate,
                so Arabic never glues "XciteوBlinkوEureka" into one token. */}
            {parts.map((p, i) =>
              p.kind === "text" ? (
                <span key={i}>{p.value}</span>
              ) : (
                <CoverageNames key={i} names={p.names} ar={p.ar} />
              ),
            )}
          </span>
        </span>
      ) : null}
      {pendingStatus ? (
        <span className="cached-chip coverage-status-chip">
          {KUWAIT_PENDING_TEXT[l]}
          {" — "}
          <button type="button" className="coverage-refresh focusable" onClick={onRefresh}>
            {REFRESH_TOKEN[l]}
          </button>
        </span>
      ) : null}
    </p>
  );
}

/* REEA-793 B1 — the pending row: a fixed box DIRECTLY UNDER the count line,
   carrying the shipped skeleton pulse-bar motif and the exact honest label.
   No competing price — the Best-price slot stays empty until a real device
   offer renders. Present ONLY when the served snapshot flags it (device-intent
   query, zero device rows, ≥1 accessory rendered); every other pass renders
   nothing and the markup stays byte-for-byte. */
const PENDING_LABEL: Record<Locale, string> = {
  en: "Best device price still loading…",
  ar: "أفضل سعر للجهاز قيد التحميل…",
};
const KUWAIT_PENDING_TEXT: Record<Locale, string> = {
  en: "Kuwait offers still loading",
  ar: "عروض الكويت لا تزال قيد التحميل",
};
const REFRESH_TOKEN: Record<Locale, string> = { en: "Refresh", ar: "تحديث" };

function DeviceLeadPendingRow({ locale }: { locale?: Locale }) {
  const l = locale ?? clientLocale();
  return (
    <div className="pending-row" role="status">
      <span className="skeleton-block pending-row-bar" aria-hidden="true" />
      <span className="pending-row-label" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
        {PENDING_LABEL[l]}
      </span>
    </div>
  );
}

/* Streamed-boundary form of the pending row: resolves with the FINAL stage
   (the same snapshot the flags were derived on at serve time) and renders
   ahead of the stamp boundary, so the pending box sits directly under the
   count line in BOTH views. Null fallback: normal passes add no box. */
function StagePendingRow(props: {
  stages: readonly Promise<LiveSearchResult>[];
  locale?: Locale;
}) {
  const snap = use(props.stages[props.stages.length - 1]);
  if (!snap.deviceLeadPending) return null;
  return <DeviceLeadPendingRow locale={props.locale} />;
}

/* REEA-964 — streamed empty-state + related band. Resolves with the FINAL
   stage (the only snapshot where every hop has settled), so the honest empty
   state and the capped related band land in the SERVED document when the run
   settled at zero confident matches. REEA-1068 — a finalized-at-budget zero
   (settled === false) renders it too: every stage that flushed was empty, so
   the served document must not leave the results area blank while the
   follow-up feed is still pending. If late offers arrive, hydration replaces
   the empty state with the cards. */
function StageEmptyState(props: {
  stages: readonly Promise<LiveSearchResult>[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
  /** REEA-965 — per-query metrics id for the band's related_click events. */
  queryId?: string;
  /** REEA-1114 AC4 — in-place reveal handlers from the results shell. */
  onRevealOutOfStock?: () => void;
  onRevealAllCountries?: () => void;
}) {
  const snap = use(props.stages[props.stages.length - 1]);
  if (props.query.length === 0) return null;
  const sections = stagedSections(snap, props.query, props.country, props.showOutOfStock);
  if (sections.primary.length > 0) return null;
  // REEA-1114 — the filter-aware classification reads the SAME final
  // snapshot the section split just read, so the count on the card is
  // exactly the rows this view hid.
  const hidden = hiddenMatchReport(
    snap.products,
    props.query,
    props.country,
    props.showOutOfStock,
  );
  const emptyCase = emptyMatchCase(
    hidden,
    sections.related.length === 0 && collectionFailed(snap.notes),
  );
  // E6 — zero offers because the collection FAILED (not a real empty shelf)
  // says so, instead of implying a no-match. Requires zero related rows too:
  // with related items the page is "near match", not an outage story.
  return (
    <>
      <EmptyState
        query={props.query}
        unavailable={emptyCase.kind === "c"}
        country={props.country}
        locale={props.locale}
        tries={snap.attemptedQueries}
        hidden={
          emptyCase.kind === "b"
            ? { filter: emptyCase.filter, count: emptyCase.count }
            : null
        }
        onReveal={
          emptyCase.kind === "b"
            ? emptyCase.filter === "stock"
              ? props.onRevealOutOfStock
              : props.onRevealAllCountries
            : undefined
        }
      />
      {/* REEA-1247 AC3/AC4 — a zero-primary page has no product, so it cannot
          own "Accessories for this product": the band is replaced by nearest
          in-market matches ("You might also like") from this run's live rows,
          with foreign-only answers kept in their own separated band. */}
      <ZeroRecovery
        products={[...sections.related, ...sections.accessory]}
        query={props.query}
        locale={props.locale}
        queryId={props.queryId}
      />
    </>
  );
}

/* REEA-601 — the streamed page paints its rows APPEND-ONLY: each flushed
   boundary keeps its slots, so what is actually on screen is the union of the
   per-stage views in paint order (a cheaper late arrival re-ranks the FINAL
   slice and can push an earlier product below PAGE_SIZE, yet its card stays
   above the fold of the streamed markup). Reading the contributor names off
   the FINAL snapshot alone forks against those rows: late re-ranked merchants
   show rows but no name, and slice-displaced merchants keep a name with zero
   rendered rows (the phantom trailing names REEA-601 reports). So the stamp
   reads the SAME union the blocks paint, derived from the very snapshots the
   boundaries consumed — still live-at-query-time data from the run's own
   fan-out, no second fetch, nothing bundled. */
export function renderedAcrossStages(
  stages: readonly Promise<LiveSearchResult>[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): Promise<NormalizedProduct[]> {
  return Promise.all(
    stages.map((stage) =>
      // REEA-1068 D1 — adopt the stage through Promise.resolve instead of
      // calling `stage.then` directly. The SSR prop layer hands client
      // components React thenables whose `then` returns void; `stage.then(cb)`
      // on one of those returns undefined, so the union below saw no views
      // and the coverage sentence believed NOTHING was rendered (measured on
      // the local production build: 22 stages → 22 undefined views on a
      // 10-card `sony` page). Promise.resolve adopts any thenable and always
      // returns a real Promise, so the painted-row union is what actually
      // painted.
      Promise.resolve(stage).then((snap) => {
        // REEA-1141 — a cached replay is not painted (the live stage paints
        // the newest version of its products), so it must not contribute
        // merchant names to the stamp either: naming a replay-only merchant
        // would fork the sentence against the rows actually on screen.
        if (snap.replay === true) return [];
        // REEA-964 — the painted set is primary slice + related band (both
        // derive from the same confidence partition the render uses), so a
        // merchant visible only through the related band still gets named.
        let view: NormalizedProduct[];
        try {
          const sections = stagedSections(snap, query, country, showOutOfStock);
          view = [
            ...sections.primary.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
            ...sections.related,
          ];
        } catch {
          // REEA-822 DEBUG: production SSR reported a non-iterable stage view here.
          console.error("REA822-DEBUG non-array stagedView; snap=", typeof snap, JSON.stringify(snap)?.slice(0, 400), "args:", typeof query, page, country, showOutOfStock);
          view = [];
        }
        return view;
      }),
    ),
  ).then((views) => {
    const seenIds = new Set<string>();
    const rows: NormalizedProduct[] = [];
    for (const view of views) {
      if (!Array.isArray(view)) {
        // REEA-822 DEBUG: production SSR reports a non-iterable stage view here.
        console.error("REA822-DEBUG non-array stage view:", typeof view, JSON.stringify(view)?.slice(0, 300));
        continue;
      }
      for (const p of view) {
        if (seenIds.has(p.productId)) continue;
        seenIds.add(p.productId);
        rows.push(p);
      }
    }
    return rows;
  });
}

/**
 * REEA-1247 AC1/AC2 — the PRIMARY shelf rows across the streamed stages, i.e.
 * the rows "Prices from …" may vouch for. The painted union above also carries
 * the related band (REEA-964), which is exactly why a zero-offer page used to
 * name related-band merchants under "Prices from" above "0 retailer offers".
 * This companion answers only the shelf question; an empty result means the
 * page has no shelf price, so the coverage sentence switches to the honest
 * zero-offer grammar.
 */
export function renderedShelfAcrossStages(
  stages: readonly Promise<LiveSearchResult>[],
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): Promise<NormalizedProduct[]> {
  return Promise.all(
    stages.map((stage) =>
      Promise.resolve(stage).then((snap) => {
        if (snap.replay === true) return [];
        try {
          return stagedSections(snap, query, country, showOutOfStock).primary.slice(
            (page - 1) * PAGE_SIZE,
            page * PAGE_SIZE,
          );
        } catch {
          return [];
        }
      }),
    ),
  ).then((views) => {
    const seenIds = new Set<string>();
    const rows: NormalizedProduct[] = [];
    for (const view of views) {
      if (!Array.isArray(view)) continue;
      for (const p of view) {
        if (seenIds.has(p.productId)) continue;
        seenIds.add(p.productId);
        rows.push(p);
      }
    }
    return rows;
  });
}

function StageCoverage(props: {
  stages: readonly Promise<LiveSearchResult>[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
  onRefresh?: () => void;
  /** REEA-1078 AC9 — merchants the reachability record names as blocked. */
  unreachableLanes?: readonly string[];
  className?: string;
}) {
  const snap = use(props.stages[props.stages.length - 1]);
  const products = use(
    useMemo(
      () => renderedAcrossStages(props.stages, props.query, props.page, props.country, props.showOutOfStock),
      [props.stages, props.query, props.page, props.country, props.showOutOfStock],
    ),
  );
  // REEA-1247 — the shelf truth is separate from the painted union: the union
  // includes related-band rows, which are suggestions, not results.
  const shelfRows = use(
    useMemo(
      () => renderedShelfAcrossStages(props.stages, props.query, props.page, props.country, props.showOutOfStock),
      [props.stages, props.query, props.page, props.country, props.showOutOfStock],
    ),
  );
  // REEA-574 R1 + REEA-601 — contributor names are recomputed at paint time
  // from the rows the streamed blocks actually render (country / out-of-stock
  // selections included), so a name in the sentence always has ≥1 visible
  // offer row beside it, and every rendered row's merchant is named. Notes
  // ride the final stage — the only snapshot where every hop has settled.
  return (
    <CoverageLine
      notes={snap.notes}
      products={products}
      query={props.query}
      locale={props.locale}
      pendingStatus={snap.kuwaitPendingStatus}
      onRefresh={props.onRefresh}
      unreachableLanes={props.unreachableLanes}
      shelfEmpty={shelfRows.length === 0}
      exactModelCards={exactModelCardsOf(shelfRows, props.query).length}
      className={props.className}
    />
  );
}

function StagedResults(props: {
  stages: Promise<LiveSearchResult>[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  onSelectCountry: (code: CountryCode | null) => void;
  onToggleStock: (next: boolean) => void;
  onRefresh: () => void;
  renderStartMs?: number;
  locale?: Locale;
  /** REEA-965 — per-query metrics id from the server render. */
  queryId?: string;
  /** REEA-1078 AC9 — merchants the reachability record names as blocked. */
  unreachableLanes?: readonly string[];
  /** REEA-1255 — server-resolved origin for the share URL. */
  shareOrigin?: string;
  /** REEA-1114 AC4 — in-place reveal handlers from the results shell. */
  onRevealOutOfStock?: () => void;
  onRevealAllCountries?: () => void;
}) {
  const { stages, query, page, country, showOutOfStock, onSelectCountry, onToggleStock, onRefresh, locale } = props;
  const finalPromise = stages[stages.length - 1];
  const [finalSnap, setFinalSnap] = useState<LiveSearchResult | null>(null);
  // REEA-437 AC-3 — one-shot flag: the follow-up feed has answered (richer
  // snapshot or "nothing pending"), so a zero at that point is the honest
  // settled answer and the heading may show its real count.
  const [feedDone, setFeedDone] = useState(false);

  // Converge onto the full-ranked snapshot once every stage has settled.
  useEffect(() => {
    let alive = true;
    finalPromise.then(
      (snap) => {
        // REEA-1162 — never downgrade a richer snapshot already folded in
        // (e.g. the follow-up feed's converged answer landed first): the
        // richness test reads offer evidence, not card count.
        if (alive) setFinalSnap((current) => preferRicherSnapshot(current, snap));
      },
      () => {
        /* staged boundaries failed — keep whatever streamed; the served
           snapshot already covers the retailers that answered. */
      },
    );
    return () => {
      alive = false;
    };
  }, [finalPromise]);

  // REEA-398 — late offers fold into the finalized page IN PLACE, no reload.
  // The server run closes the stream on its completion budget; merchants that
  // answer after that keep running behind the response and are handed to the
  // open page by the follow-up feed (/api/results-followup — the SAME run's
  // converged chain, not a second fan-out). One bounded fetch per view: a
  // richer live snapshot replaces the finalized one; a poorer, or absent
  // answer keeps what is already rendered. REEA-1162 — "richer" is measured on
  // the offer evidence the shopper can act on, because the merge pass folds
  // colourways into ONE card: the converged answer legitimately carries FEWER
  // products while carrying MORE offers, and the old products.length test
  // rejected it (the stale forked shelf stayed — the 3/6 merged-card defect).
  // The coverage line re-renders from the merged notes, so a merchant named as
  // "no answer within budget" moves to the answered side exactly when its
  // offers appear.
  const followedQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (followedQueryRef.current === query) return;
    followedQueryRef.current = query;
    const controller = new AbortController();
    fetch(`/api/results-followup?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<LiveSearchResult | null>) : null))
      .then((late) => {
        if (!late || !Array.isArray(late.products)) return;
        setFinalSnap((current) => preferRicherSnapshot(current, late));
      })
      .catch(() => {
        /* feed unavailable — the finalized document already carries every
           offer that landed inside the completion budget */
      })
      .finally(() => setFeedDone(true));
    return () => controller.abort();
  }, [query]);

  // REEA-37 funnel events fire once per CONVERGED result set (identity with
  // the REEA-186 stock selection included), so partial flushes never emit
  // half-count impression storms. REEA-964: the count is the PRIMARY
  // (confident) set — the related band is not a result.
  const finalSections = finalSnap
    ? stagedSections(finalSnap, query, country, showOutOfStock)
    : null;
  const products = finalSections
    ? finalSections.primary.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    : null;
  // REEA-1201 — the honest in-scope total is the FULL primary shelf, not the
  // page slice; the thin-shelf decision folds the cards this page renders.
  const inScopeCount = finalSections ? finalSections.primary.length : 0;
  // REEA-1261 AC-2 — on a brand+model query the count line counts the
  // exact-model cards THIS page renders, read through the same predicate the
  // shelf ranking uses, so the sentence and the painted shelf cannot drift.
  const exactModelCards = products ? exactModelCardsOf(products, query) : [];
  const exactModelLine =
    products !== null && isExactModelQuery(query) && exactModelCards.length > 0
      ? {
          count: exactModelCards.length,
          market: marketName(marketViewScope(country) ?? HOME_MARKET, locale),
          noneInMarket: exactModelOnlyOutsideMarket(
            exactModelCards,
            marketViewScope(country) ?? HOME_MARKET,
          ),
        }
      : null;
  const thinShelf = products ? isThinShelf(products, marketViewScope(country)) : false;
  // REEA-1114 — the filter-aware count and the empty-state case are derived
  // from the SAME converged snapshot the shelf renders (and the follow-up
  // fold keeps them in step when late offers land). The chip carries the
  // count before the shopper reaches the empty state (AC3); the empty state
  // names the filter and the one-tap reveal (AC1).
  const hiddenReport = finalSnap
    ? hiddenMatchReport(finalSnap.products, query, country, showOutOfStock)
    : null;
  const emptyCase =
    finalSnap && finalSections
      ? emptyMatchCase(
          hiddenReport ?? { stock: 0, country: 0 },
          finalSections.related.length === 0 && collectionFailed(finalSnap.notes),
        )
      : null;
  const hiddenByStock = hiddenReport?.stock ?? 0;
  const hiddenByCountry = hiddenReport?.country ?? 0;
  const eventsKey = products
    ? `${query}|${page}|${products.length}|${showOutOfStock ? 1 : 0}`
    : "";
  const sentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!products || !query || sentKeyRef.current === eventsKey) return;
    sentKeyRef.current = eventsKey;
    trackEvents([
      { type: "search_submitted", query, result_count: products.length },
      ...(products.length === 0 ? [{ type: "zero_results" as const, query }] : []),
      ...products.map((p, i) => ({
        type: "result_impressed" as const,
        query,
        rank: (page - 1) * PAGE_SIZE + i,
        item_id: p.productId,
      })),
      // REEA-965 — offer_rendered/coupon_hit ride the SAME converged-set pass
      // (one emission per rendered card, coupon_hit exactly where the card's
      // coupon module has an offer, so the FR-3.3 ratio can never drift
      // between two snapshots). Fire-and-forget; the transport chunks to the
      // endpoint's per-request cap.
      ...(props.queryId
        ? buildOfferRenderedEvents({ queryId: props.queryId, offers: offerMetricsFor(products, props.country ?? null) })
        : []),
    ]);
  }, [eventsKey, query, page, products, props.queryId]);

  if (finalSnap && finalSections && products) {
    // Converged view: full count + empty state, identical to the blocking path.
    // REEA-332 item 2: the count heading rides BOTH branches, so the zero case
    // keeps its heading + hint line exactly where the streamed shell put them —
    // only the body below changes.
    // REEA-437 AC-2/AC-3 — a zero that a finalized-at-budget snapshot states is
    // provisional: the heading keeps its skeleton (and the coverage line keeps
    // naming the pending retailers) until the follow-up feed has answered; the
    // empty state then appears only after the widened retry also came back
    // zero, and names what was tried.
    const provisionalZero = products.length === 0 && finalSnap.settled === false && !feedDone;
    if (provisionalZero) {
      // REEA-1156 D11 — a finalized-at-budget zero must NOT unmount the
      // designed empty panel while the follow-up feed is still pending: that
      // was the 375-only blank band (the 1280 pass kept the panel because it
      // converged). The panel is mounted from the same zero state as the
      // settled view, with the partial-response banner above it; the meta
      // line above now carries the real "0 results … collected live just
      // now" instead of the lone "." placeholder.
      return (
        <ResultsErrorBoundary locale={locale}>
          <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} hiddenByStock={hiddenByStock} hiddenByCountry={hiddenByCountry} />
          <ResultsHead query={query} country={country} locale={locale}>
            <Suspense fallback={null}>
              <ResultsHint stage={finalPromise} query={query} page={page} country={country} showOutOfStock={showOutOfStock} locale={locale} />
            </Suspense>
          </ResultsHead>
          <StatusLegend locale={locale} />
          <Suspense fallback={<StampGhost locale={locale} />}>
            <ResultsSubline stage={finalPromise} query={query} page={page} country={country} showOutOfStock={showOutOfStock} renderStartMs={props.renderStartMs} locale={locale} />
          </Suspense>
          {/* REEA-1218 AC-3 — the alias disclosure survives the provisional
              zero view too, so a still-converging Arabic query never looks
              like it silently swapped the shopper's language. */}
          <AliasSubstitutionLine query={query} />
          {/* REEA-793 — pending row ahead of the stamp boundary in this view too. */}
          <Suspense fallback={null}>
            <StagePendingRow stages={stages} locale={locale} />
          </Suspense>
          {query.length > 0 ? (
            <>
              {/* Partial-response banner above the designed panel. */}
              <CoverageLine notes={finalSnap.notes} products={products} query={query} locale={locale} unreachableLanes={props.unreachableLanes} exactModelCards={0} />
              <EmptyState
                query={query}
                unavailable={emptyCase?.kind === "c"}
                country={country}
                locale={locale}
                tries={finalSnap.attemptedQueries}
                hidden={
                  emptyCase?.kind === "b"
                    ? { filter: emptyCase.filter, count: emptyCase.count }
                    : null
                }
                onReveal={
                  emptyCase?.kind === "b"
                    ? emptyCase.filter === "stock"
                      ? props.onRevealOutOfStock
                      : props.onRevealAllCountries
                    : undefined
                }
              />
              <ZeroRecovery
                products={[...finalSections.related, ...finalSections.accessory]}
                query={query}
                locale={locale}
                queryId={props.queryId}
              />
            </>
          ) : null}
        </ResultsErrorBoundary>
      );
    }
    return (
      <ResultsErrorBoundary locale={locale}>
        <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} hiddenByStock={hiddenByStock} hiddenByCountry={hiddenByCountry} />
        <ResultsHead query={query} country={country} locale={locale}>
          {products.length === 0 && query.length > 0 && emptyCase?.kind === "a" ? <HintLine locale={locale} /> : null}
        </ResultsHead>
        <StatusLegend locale={locale} />
        <ResultsMeta products={products} query={query} renderStartMs={props.renderStartMs} locale={locale} />
        {/* REEA-1218 AC-3 — the Arabic substitution line sits above the count
            line, so the shopper sees which Latin spelling answered their
            Arabic query before reading the true offer count. */}
        <AliasSubstitutionLine query={query} />
        {/* REEA-1201 AC 7b-1/7b-3 — the honest in-scope count and, when every
            card is single-retailer, the thin-shelf sentence. Both sit above
            the shelf and read the payload's own scope decision.
            REEA-1261 AC-2 — a brand+model query replaces the in-scope sentence
            with the exact-model count, which counts only the cards that answer
            the shopper's exact product and discloses when none is in market. */}
        {exactModelLine ? (
          <ExactModelCountLine
            count={exactModelLine.count}
            market={exactModelLine.market}
            noneInMarket={exactModelLine.noneInMarket}
            locale={locale}
          />
        ) : inScopeCount > 0 ? (
          <InScopeCountLine count={inScopeCount} query={query} locale={locale} />
        ) : null}
        {thinShelf ? <ThinShelfLine query={query} locale={locale} /> : null}
        {/* REEA-793 B1 — the pending row sits DIRECTLY UNDER the count line
            in the converged view, before the coverage stamp. */}
        {finalSnap.deviceLeadPending ? <DeviceLeadPendingRow locale={locale} /> : null}
        {products.length === 0 && query.length > 0 ? (
          <>
            {/* REEA-1156 D11 — the partial-response banner sits ABOVE the
                designed empty panel on a zero-row page, so the explanation
                precedes the panel instead of leaving a blank band.
                REEA-1068 D1 — on a zero-row page the coverage sentence keeps
                only its failure/empty half (the lanes that errored or
                answered with nothing), so "No match found" is explained
                instead of bare. AC9's unreachable names ride it too.
                REEA-1078 AC9 / REEA-1114 AC2(c) — the existing unreachable
                sentence must still render on a zero-row page: it is the one
                statement that explains why an empty shelf is not a no-match. */}
            <CoverageLine notes={finalSnap.notes} products={products} query={query} locale={locale} unreachableLanes={props.unreachableLanes} exactModelCards={0} />
            {/* REEA-964 — the honest empty state rides the primary position;
                the related band renders BELOW it, clearly not a result.
                REEA-1114 — case (b) names the filter that hid the rows and
                reveals them in place; the spelling copy is case (a) only. */}
            <EmptyState
              query={query}
              unavailable={emptyCase?.kind === "c"}
              country={country}
              locale={locale}
              tries={finalSnap.attemptedQueries}
              hidden={
                emptyCase?.kind === "b"
                  ? { filter: emptyCase.filter, count: emptyCase.count }
                  : null
              }
              onReveal={
                emptyCase?.kind === "b"
                  ? emptyCase.filter === "stock"
                    ? props.onRevealOutOfStock
                    : props.onRevealAllCountries
                  : undefined
              }
            />
            {/* REEA-1247 AC3/AC4 — zero primary shelf: no accessory band on a
                page with no product; nearest in-market matches instead. */}
            <ZeroRecovery
              products={[...finalSections.related, ...finalSections.accessory]}
              query={query}
              locale={locale}
              queryId={props.queryId}
            />
          </>
        ) : (
          <>
            <CoverageLine notes={finalSnap.notes} products={products} query={query} locale={locale} pendingStatus={finalSnap.kuwaitPendingStatus} onRefresh={onRefresh} unreachableLanes={props.unreachableLanes} exactModelCards={exactModelCardsOf(products, query).length} className="rc-coverage-top" />
            <ResultsGrid
              products={products}
              query={query}
              page={page}
              country={country}
              showOutOfStock={showOutOfStock} locale={locale}
              renderStartMs={props.renderStartMs}
              queryId={props.queryId}
              shareOrigin={props.shareOrigin}
              /* REEA-835/847 — batch-pending only while the Kuwait batch may
                  still land: a finalized-at-budget snapshot clears when the
                  follow-up feed has answered (the REEA-437 one-shot grammar);
                  a converged snapshot was never pending. The card decides the
                  withhold on its own flagged offer (zero Kuwait-primary
                  rendered, or the lead is non-KWD — REEA-847). */
              kuwaitBatchPending={finalSnap.settled === false && !feedDone}
              kuwaitPendingStatus={finalSnap.kuwaitPendingStatus === true}
            />
            {/* REEA-1201 AC 7b-2 — the labelled accessory band sits BELOW the
                primary shelf, never above a primary-scope card. */}
            <AccessoryBand items={finalSections.accessory} locale={locale} queryId={props.queryId} />
            <RelatedBand items={finalSections.related} locale={locale} queryId={props.queryId} />
          </>
        )}
      </ResultsErrorBoundary>
    );
  }

  // Streaming view: append-only flushes; the heading lands with the first
  // flush (REEA-224 item 2 — part of the initial server shell, count-so-far
  // deepening to the final figure on convergence) and only the empty state
  // waits for the converged snapshot, so a partial arrival never reads as
  // "no results".
  // REEA-189: the container is a flex column so flush blocks stack full-width
  // and the block `order` values (Devices 1 / Accessories 2) hold across
  // flushes — late devices still stack above earlier accessories.
  return (
    <ResultsErrorBoundary locale={locale}>
      <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} hiddenByStock={hiddenByStock} hiddenByCountry={hiddenByCountry} />
      {/* REEA-1069 — the Direction A h1 renders IMMEDIATELY from the query
          (design loading state: heading on screen, only the shelf busy); the
          count/offers/age subline streams with the final snapshot in the SAME
          lh-tier reserve the previous heading slot used, so nothing below
          moves when it lands. */}
      <ResultsHead query={query} country={country} locale={locale}>
        <Suspense fallback={null}>
          <ResultsHint
            stage={finalPromise}
            query={query}
            page={page}
            country={country}
            showOutOfStock={showOutOfStock}
            locale={locale}
          />
        </Suspense>
      </ResultsHead>
      {/* REEA-1218 AC-3 — render the alias disclosure in the INITIAL streamed
          shell too, not only after convergence, so the served document already
          carries it for QA and the shopper sees it before the shelf lands. */}
      <AliasSubstitutionLine query={query} />
      <StatusLegend locale={locale} />
      <Suspense fallback={<StampGhost locale={locale} />}>
        <ResultsSubline
          stage={finalPromise}
          query={query}
          page={page}
          country={country}
          showOutOfStock={showOutOfStock}
          renderStartMs={props.renderStartMs}
          locale={locale}
        />
      </Suspense>
      {/* REEA-793 — the pending-row boundary is REORDERED AHEAD of the stamp
          boundary so the pending box lands directly under the count line in
          the streamed view as well; normal passes render null and add nothing. */}
      <Suspense fallback={null}>
        <StagePendingRow stages={stages} locale={locale} />
      </Suspense>
      <Suspense fallback={<StampGhost locale={locale} />}>
        <StageCoverage
          stages={stages}
          query={query}
          page={page}
          country={country}
          showOutOfStock={showOutOfStock}
          locale={locale}
          onRefresh={onRefresh}
          unreachableLanes={props.unreachableLanes}
          className="rc-coverage-top"
        />
      </Suspense>
      <div className="rc-results-grid flex min-w-0 flex-col items-stretch gap-4" style={{ marginTop: "var(--rc-space-8)" }}>
        {/* REEA-970 — the first-flush boundary now carries the named-slot
            ghost: while stage 0 is in flight the card region paints the
            retailers' named skeleton slots (StagedGridGhost) instead of the
            blank band the null fallback left. Later append boundaries keep
            fallback={null} — they append below already-painted content. */}
        <Suspense fallback={<StagedGridGhost />}>
          <StageAppend
            stages={stages}
            index={0}
            query={query}
            page={page}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={props.renderStartMs}
            queryId={props.queryId}
            shareOrigin={props.shareOrigin}
          />
        </Suspense>
      </div>
      {/* REEA-964 — streamed honest empty state + capped related band: land in
          the served document when the final stage settles at zero confident
          matches; render null on every confident-match pass. */}
      <Suspense fallback={null}>
        <StageEmptyState
          stages={stages}
          query={query}
          page={page}
          country={country}
          showOutOfStock={showOutOfStock}
          locale={locale}
          queryId={props.queryId}
          onRevealOutOfStock={props.onRevealOutOfStock}
          onRevealAllCountries={props.onRevealAllCountries}
        />
      </Suspense>
    </ResultsErrorBoundary>
  );
}

function ResultsInner(props: {
  query?: string;
  page?: number;
  products?: NormalizedProduct[];
  suggestions?: NormalizedProduct[];
  country?: CountryCode | null;
  showOutOfStock?: boolean;
  stages?: Promise<LiveSearchResult>[];
  renderStartMs?: number;
  locale?: Locale;
  queryId?: string;
  unreachableLanes?: readonly string[];
  shareOrigin?: string;
}) {
  const searchParams = useSearchParams();
  // REEA-279: one resolution per view — prop first (server-resolved), then
  // the client chain (cookie → browser hint → "en"); every child receives
  // this value explicitly, so SSR markup and hydration always agree.
  const locale = props.locale ?? clientLocale();
  const router = useRouter();
  // AC-U4 (REEA-13): malformed/oversized params degrade safely before use.
  const query = props.query ?? sanitizeSearchQuery(searchParams.get("q")) ?? "";
  const urlPage = props.page ?? sanitizePage(searchParams.get("page"));
  // REEA-170: the server-resolved selection wins; otherwise read the URL, then
  // the remembered choice (same-tab slot, then the REEA-280 preference cookie)
  // so a returning tab keeps its filter without re-selecting.
  // REEA-280: the last layer is the coarse browser-language hint — it mirrors
  // what the server derives from Accept-Language on the live path, so the
  // static-host fallback starts on the same market default. A null default
  // still means "All" = unchanged behavior.
  const browserHint =
    typeof navigator === "undefined"
      ? null
      : countryFromAcceptLanguage(navigator.language ?? undefined);
  // REEA-1177 AC 6d-2 — the URL chain reads `?market=` first, then the
  // legacy `?c=`; explicit ALL is the null selection. The server-resolved
  // prop always wins, and with no selection the default is Kuwait (home).
  const urlMarket = sanitizeMarket(searchParams.get("market"));
  const urlLegacyMarket = sanitizeMarket(searchParams.get("c"));
  const resolvedCountry =
    props.country !== undefined
      ? props.country
      : urlMarket !== null
        ? (urlMarket === "ALL" ? null : urlMarket)
        : urlLegacyMarket !== null
          ? (urlLegacyMarket === "ALL" ? null : urlLegacyMarket)
          : recallCountry() ?? browserHint ?? "KW";
  // REEA-186/REEA-1177 AC 6d-2 — same resolution chain for stock: server
  // value wins, then `?stock=in|all`, then the legacy `?oos=`, then the
  // remembered choice; default is hide out-of-stock listings.
  const resolvedOos =
    props.showOutOfStock !== undefined
      ? props.showOutOfStock
      : sanitizeStockParam(searchParams.get("stock")) ??
        sanitizeShowOutOfStock(searchParams.get("oos")) ??
        recallShowOutOfStock() ??
        false;

  // REEA-291 AC4 — the selections are CLIENT-side filters over the loaded
  // payload: the pills/toggle re-render the view from the staged/plain props
  // with no navigation and no refetch. The in-place override lives until the
  // served view's identity changes (new query, new page, or a refreshed
  // server resolution after the explicit Refresh action), then the
  // server-resolved chain takes over again from the URL / remembered
  // preference. The override starts from the SAME values the server resolved,
  // so hydration matches the served markup.
  const viewKey = `${query}|${urlPage}|${resolvedCountry ?? ""}|${resolvedOos ? 1 : 0}`;
  const [selectionOverride, setSelectionOverride] = useState<{
    key: string;
    country: CountryCode | null;
    showOutOfStock: boolean;
  } | null>(null);
  const overridden = selectionOverride !== null && selectionOverride.key === viewKey;
  const country = overridden ? selectionOverride.country : resolvedCountry;
  const showOutOfStock = overridden ? selectionOverride.showOutOfStock : resolvedOos;
  // Selection changes reset to page 1 — the filtered set is a different
  // result set (same rule the old link targets carried).
  const page = overridden ? 1 : urlPage;

  // Selection handlers: filter the loaded payload immediately (AC4) and keep
  // the URL echo in sync for sharing / a later reload — history.replaceState
  // updates the address without navigation or network round-trip.
  const applySelection = (nextCountry: CountryCode | null, nextOos: boolean) => {
    setSelectionOverride({ key: viewKey, country: nextCountry, showOutOfStock: nextOos });
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", buildResultsHref(query, 1, nextCountry, nextOos));
    }
  };
  const onSelectCountry = (code: CountryCode | null) => applySelection(code, showOutOfStock);
  const onToggleStock = (next: boolean) => applySelection(country, next);
  // REEA-1114 AC4 — the empty state's one-tap reveal. It rides the SAME
  // in-place selection path as the chips (client state + URL echo, no
  // navigation, no second collection), keeps the query, and records the
  // choice for the next search exactly like the chip's own click.
  const onRevealOutOfStock = () => {
    rememberShowOutOfStock(true);
    applySelection(country, true);
  };
  const onRevealAllCountries = () => {
    rememberCountry(null);
    applySelection(null, showOutOfStock);
  };
  // REEA-291 AC4 — the ONLY full live re-fetch path: stamps the one-shot
  // refresh cookie, then re-runs the server collection for this query even
  // inside the ≤60 s memo window (AC5), so collection timestamps update while
  // the in-place selections above never hit the network.
  // REEA-439 — the request also rides a UNIQUE URL (`?_r=` stamp), so the
  // bounded shared edge entry never answers the Refresh: a unique URL is a
  // guaranteed miss and the live walk re-runs with newer scrapedAt. Plain
  // repeats keep the current address and may answer warm inside the window.
  const onRefresh = () => {
    markLiveRefresh();
    if (typeof window !== "undefined") {
      router.replace(withRefreshBypass(window.location.href, Date.now()));
      return;
    }
    router.refresh();
  };

  const staged = props.stages && props.stages.length > 0 ? props.stages : null;

  const matched = staged || props.products ? [] : query ? searchProducts(query, PRODUCTS) : [];
  const allProducts = staged
    ? []
    : props.products ?? (matched.length > 0 ? matched.map((m) => m.product) : PRODUCTS);
  const served = staged || props.products
    ? allProducts // server already paginated
    : allProducts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // The server filters offers BEFORE grouping, so everything derived
  // (counts, cheapest-first, alternatives) already honors the selection; this
  // pass is idempotent there and is the whole filter on the static-host
  // catalog fallback. Same for the stock selection (REEA-186); REEA-822 adds
  // the exact-SKU keep so the fallback path matches the staged view's rule.
  // REEA-964: the confidence partition rides the SAME filtered set on the
  // fallback path — primary results vs the capped related band — so the
  // static-host view obeys the two-section contract too.
  const plainSections = shelfSectionsFromProducts(served, query, country, showOutOfStock);
  const products = plainSections.primary;
  const matchCount = products.length;
  const zero = query.length > 0 && matchCount === 0;
  // REEA-1201 — same honest count/thin-shelf decisions on the fallback path.
  const plainInScopeCount = plainSections.primary.length;
  // REEA-1261 AC-2 — the same exact-model count on the fallback path, from
  // the same predicate, so both render paths state the same number.
  const plainExactModelCards = exactModelCardsOf(products, query);
  const plainExactModelLine =
    isExactModelQuery(query) && plainExactModelCards.length > 0
      ? {
          count: plainExactModelCards.length,
          market: marketName(marketViewScope(country) ?? HOME_MARKET, locale),
          noneInMarket: exactModelOnlyOutsideMarket(
            plainExactModelCards,
            marketViewScope(country) ?? HOME_MARKET,
          ),
        }
      : null;
  const plainThinShelf = isThinShelf(products, marketViewScope(country));
  // REEA-1114 — the static-host fallback path obeys the same filter-aware
  // empty state: a zero that a filter hid names the filter and reveals the
  // rows in place instead of blaming the spelling.
  const plainHidden = hiddenMatchReport(served, query, country, showOutOfStock);
  const plainEmptyCase = emptyMatchCase(plainHidden, false);
  // REEA-37: funnel instrumentation — search_submitted (+ zero_results) and
  // result_impressed fire once per (query, page, result-set). Dedup key is
  // component-local memory only; nothing is persisted client-side. The stock
  // selection is part of the result-set identity (REEA-186): toggling shows or
  // hides listings, so impressions of the new set must not be deduped away.
  // The staged path owns its own converged-set events (StagedResults below).
  const eventsKey = `${query}|${page}|${matchCount}|${showOutOfStock ? 1 : 0}`;
  const sentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (staged || !query || sentKeyRef.current === eventsKey) return;
    sentKeyRef.current = eventsKey;
    trackEvents([
      { type: "search_submitted", query, result_count: matchCount },
      ...(zero ? [{ type: "zero_results" as const, query }] : []),
      ...products.map((p, i) => ({
        type: "result_impressed" as const,
        query,
        rank: (page - 1) * PAGE_SIZE + i,
        item_id: p.productId,
      })),
      // REEA-965 — offer_rendered/coupon_hit on the same converged-set pass
      // as the plain path's impressions (see the staged-path twin above).
      ...(props.queryId
        ? buildOfferRenderedEvents({ queryId: props.queryId, offers: offerMetricsFor(products, props.country ?? null) })
        : []),
    ]);
  }, [staged, eventsKey, query, page, zero, matchCount, products, props.queryId]);

  if (staged) {
    return (
      <StagedResults
        stages={staged}
        query={query}
        page={page}
        country={country}
        showOutOfStock={showOutOfStock} locale={locale}
        onSelectCountry={onSelectCountry}
        onToggleStock={onToggleStock}
        onRefresh={onRefresh}
        renderStartMs={props.renderStartMs}
        queryId={props.queryId}
        unreachableLanes={props.unreachableLanes}
        shareOrigin={props.shareOrigin}
        onRevealOutOfStock={onRevealOutOfStock}
        onRevealAllCountries={onRevealAllCountries}
      />
    );
  }

  return (
    <ResultsErrorBoundary locale={locale}>
      <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} hiddenByStock={plainHidden.stock} hiddenByCountry={plainHidden.country} />
      <ResultsHead query={query} country={country} locale={locale}>
        {zero && plainEmptyCase.kind === "a" ? <HintLine locale={locale} /> : null}
      </ResultsHead>
      <StatusLegend locale={locale} />
      <ResultsMeta products={products} query={query} renderStartMs={props.renderStartMs} locale={locale} />
      {/* REEA-1218 AC-3 — the same Arabic substitution disclosure on the
          static-host / blocking fallback path. */}
      <AliasSubstitutionLine query={query} />
      {/* REEA-1201 AC 7b-1/7b-3 — honest count and thin-shelf sentence on the
          fallback path too, from the same scope-aware partition.
          REEA-1261 AC-2 — the exact-model sentence wins on a brand+model
          query, exactly as on the staged path. */}
      {plainExactModelLine ? (
        <ExactModelCountLine
          count={plainExactModelLine.count}
          market={plainExactModelLine.market}
          noneInMarket={plainExactModelLine.noneInMarket}
          locale={locale}
        />
      ) : plainInScopeCount > 0 ? (
        <InScopeCountLine count={plainInScopeCount} query={query} locale={locale} />
      ) : null}
      {plainThinShelf ? <ThinShelfLine query={query} locale={locale} /> : null}
      {zero ? (
        <>
          <EmptyState
            query={query}
            country={country}
            locale={locale}
            hidden={
              plainEmptyCase.kind === "b"
                ? { filter: plainEmptyCase.filter, count: plainEmptyCase.count }
                : null
            }
            onReveal={
              plainEmptyCase.kind === "b"
                ? plainEmptyCase.filter === "stock"
                  ? onRevealOutOfStock
                  : onRevealAllCountries
                : undefined
            }
          />
          <ZeroRecovery
            products={[...plainSections.related, ...plainSections.accessory]}
            query={query}
            locale={locale}
            queryId={props.queryId}
          />
        </>
      ) : (
        <>
          <ResultsGrid
            products={products}
            query={query}
            page={page}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={props.renderStartMs}
            queryId={props.queryId}
            shareOrigin={props.shareOrigin}
          />
          <AccessoryBand items={plainSections.accessory} locale={locale} queryId={props.queryId} />
          <RelatedBand items={plainSections.related} locale={locale} queryId={props.queryId} />
        </>
      )}
    </ResultsErrorBoundary>
  );
}
