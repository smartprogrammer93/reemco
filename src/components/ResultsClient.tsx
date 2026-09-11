"use client";

import { Component, Suspense, useEffect, useRef, useState, use, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import CountryFilter from "@/components/CountryFilter";
import StockToggle from "@/components/StockToggle";
import ProductResultCard from "@/components/ProductResultCard";
import { searchProducts, suggestProducts } from "@/lib/search";
import { sanitizePage, sanitizeSearchQuery } from "@/lib/search-params";
import {
  bestBadgeIndex,
  filterProductsByStock,
  recallShowOutOfStock,
  sanitizeShowOutOfStock,
} from "@/lib/stock";
import {
  buildResultsHref,
  countryFromAcceptLanguage,
  filterProductsByCountry,
  recallCountry,
  sanitizeCountry,
  type CountryCode,
} from "@/lib/country";
import { trackEvents } from "@/lib/telemetry";
import { PRODUCTS } from "@/lib/feed";
import { isAccessoryTitle, partitionForQuery } from "@/lib/relevance";
import { coverageLine, type LiveSearchResult } from "@/lib/collect/coverage";
import { markLiveRefresh, withRefreshBypass } from "@/lib/query-cache";
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";
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

const PAGE_SIZE = 20;

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
        <div
          className="result-card"
          role="alert"
          style={{ borderLeft: "3px solid var(--rc-error)", background: "var(--rc-error-bg)" }}
        >
          <h2 style={{ font: "var(--rc-text-title)", color: "var(--rc-ink)" }}>
            {t.errorTitle}
          </h2>
          <p className="mt-1" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
            {t.errorBodyShort}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-primary focusable mt-4 min-h-11 px-4"
          >
            {t.retry}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* Brief v4 loading state: card-shaped ghosts with sheen + the slim amber
   pulse bar carrying the "checking stores" label — never a blank area.
   REEA-224 item 2: ghosts + heading slot mirror the real geometry (see
   .skeleton-card in globals.css and results/loading.tsx — kept identical). */
function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden>
      <div className="skeleton-block w-2/3" />
      <div className="skeleton-block mt-2 w-1/3" />
      <div className="skeleton-block mt-4 w-32" />
      <div className="skeleton-block mt-4 w-full" />
      <div className="skeleton-block mt-2 w-full" />
    </div>
  );
}

/* Heading slot at the h1's own display height (same clamp math as
   --rc-text-display × line-height 1.05) so the settled heading lands
   without pushing anything below it. Shared by the initial fallback and
   the REEA-437 provisional-zero state. */
function HeadingGhost() {
  return (
    <div className="skeleton-block" style={{ width: "45%", height: "clamp(36px, 4.8vw, 55px)" }} aria-hidden />
  );
}

export function LoadingFallback({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="space-y-4">
      <div className="pulse-bar" aria-hidden>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        {t.checkingStores}
      </p>
      <HeadingGhost />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

/* Brief v4 empty state: single card echoing the query, suggested-query pills
   from the relaxed live collection, Retry. The query lives in the URL, so
   Retry never loses it.
   REEA-281 AC-3: the zero-result state ALWAYS carries the three CATEGORY
   links — not one-off product examples — so the shopper has at least THREE
   clickable ways onward whatever the relaxed live collection returned (a
   broad category stays useful whatever was being searched). Live suggestion
   pills ride FIRST when the collection found anything; categories follow,
   deduped against them. */
/* REEA-279: the three category pills read their labels from the locale table
   so the AR shell offers Arabic queries (Arabic queries match Arabic
   retailer titles exactly like English ones — same live path). */
function EmptyState({
  query,
  suggestions,
  country,
  locale,
  tries,
}: {
  query: string;
  suggestions: NormalizedProduct[];
  country: CountryCode | null;
  locale?: Locale;
  /** REEA-437 AC-2 — the query forms the live run issued before declaring
   *  empty (whole query, then the trimmed-token widening), named on the card
   *  so a zero answer states what was tried instead of just saying "none". */
  tries?: string[];
}) {
  const t = getStrings(locale ?? clientLocale());
  const pills = suggestions.slice(0, 3).map((p) => p.title);
  // AC-3 floor: the three category links ride in whatever the live
  // collection returned — deduped so a category that IS the suggestion is
  // not repeated, but never fewer than the three broad onward paths.
  for (const c of [t.catPhones, t.catFragrances, t.catKitchen]) {
    if (!pills.includes(c)) pills.push(c);
  }
  return (
    <div className="result-card mx-auto w-full max-w-xl">
      <h2 style={{ font: "var(--rc-text-h2)", color: "var(--rc-ink)" }}>
        {fill(t.emptyTitle, { q: query })}
      </h2>
      <p className="mt-2" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.emptyBody}
      </p>
      {tries && tries.length > 0 ? (
        <p className="mt-2" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {fill(t.triedForms, { tries: tries.join('”, “') })}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {pills.map((q) => (
          <Link key={q} href={buildResultsHref(q, 1, country)} className="query-pill query-pill-on-light">
            {q}
          </Link>
        ))}
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="btn-primary focusable mt-4 h-11 px-5"
      >
        {t.retry}
      </button>
    </div>
  );
}

/* Design v3 §5.2 grid: single-column list, two columns only ≥1280px.
   minmax(0,1fr) tracks keep long product titles from widening the grid past
   the viewport at 375px (smoke step 5). Shared by the staged and plain paths
   so both converge on identical markup.
   REEA-189 Rule 2 — device-intent queries render TWO STACKED grids (Devices
   above Accessories, each keeping the incoming rank order inside it); every
   other query keeps the plain single grid. */
function ResultsGrid({
  products,
  query,
  page,
  country,
  showOutOfStock,
  renderStartMs,
  locale,
}: {
  products: NormalizedProduct[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const tier = partitionForQuery(products);
  if (!tier.tiered) {
    // REEA-213: exactly one Best-price badge, on the first in-stock card of
    // the final sorted order (first card when nothing is stocked).
    const bestAt = bestBadgeIndex(products);
    return (
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]"
        style={{ marginTop: "var(--rc-space-8)" }}
      >
        {products.map((p, i) => (
          <ProductResultCard
            key={p.productId}
            product={p}
            isBest={i === bestAt}
            query={query}
            rank={(page - 1) * PAGE_SIZE + i}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={renderStartMs}
          />
        ))}
      </div>
    );
  }
  const bestAt = bestBadgeIndex(tier.devices);
  return (
    <>
      <div aria-label={t.devicesLabel}>
        <div
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]"
          style={{ marginTop: "var(--rc-space-8)" }}
        >
          {tier.devices.map((p, i) => (
            <ProductResultCard
              key={p.productId}
              product={p}
              isBest={i === bestAt}
              query={query}
              rank={(page - 1) * PAGE_SIZE + i}
              country={country}
              showOutOfStock={showOutOfStock} locale={locale}
              renderStartMs={renderStartMs}
            />
          ))}
        </div>
      </div>
      {tier.accessories.length > 0 && (
        <div aria-label={t.accessoriesLabel}>
          <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]"
            style={{ marginTop: "var(--rc-space-4)" }}
          >
            {tier.accessories.map((p, i) => (
              <ProductResultCard
                key={p.productId}
                product={p}
                isBest={false}
                query={query}
                rank={(page - 1) * PAGE_SIZE + tier.devices.length + i}
                country={country}
                showOutOfStock={showOutOfStock} locale={locale}
                renderStartMs={renderStartMs}
              />
            ))}
          </div>
        </div>
      )}
    </>
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
}: {
  country: CountryCode | null;
  showOutOfStock: boolean;
  onSelectCountry: (code: CountryCode | null) => void;
  onToggleStock: (next: boolean) => void;
  onRefresh: () => void;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  return (
    /* REEA-170: country pills above the list — same control for both the
       result list and the empty state, active choice echoed from the URL.
       REEA-186: stock selection beside the country pills — visible in both
       the result list and the empty state, same control.
       REEA-291 AC4: the pills and the checkbox filter the already-loaded
       payload IN PLACE (ResultsClient state); the Refresh button is the one
       explicit action that re-runs the live collection server-side. */
    <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: "var(--rc-space-4)" }}>
      <CountryFilter country={country} onSelect={onSelectCountry} locale={locale} />
      <StockToggle showOutOfStock={showOutOfStock} locale={locale} onToggle={onToggleStock} />
      <button type="button" onClick={onRefresh} className="query-pill query-pill-on-light focusable">
        {t.refresh}
      </button>
    </div>
  );
}

/* Selections apply BEFORE slicing, per snapshot — same chain (country, then
   stock) the plain path runs, so staged and converged views agree. */
function stagedView(
  snap: LiveSearchResult,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): NormalizedProduct[] {
  const filtered = filterProductsByStock(
    filterProductsByCountry(snap.products, country),
    showOutOfStock,
  );
  return filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

function stagedSuggestions(
  snap: LiveSearchResult,
  country: CountryCode | null,
  showOutOfStock: boolean,
): NormalizedProduct[] {
  return filterProductsByStock(
    filterProductsByCountry(snap.suggestions ?? snap.products.slice(0, 3), country),
    showOutOfStock,
  );
}

/* Design v3 grid inside one streaming block (see StageAppend). */
const GRID_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]";

function FlushBlock(props: {
  label?: string;
  order: number;
  products: NormalizedProduct[];
  bestAt: number;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
}) {
  const { label, order, products, bestAt, query, page, country, showOutOfStock, renderStartMs, locale } = props;
  if (products.length === 0) return null;
  // REEA-213: inside a participating block the badge rides the first
  // in-stock card of the final sorted order, never a later cheaper one.
  const badgeAt = bestAt < 0 ? -1 : bestBadgeIndex(products);
  return (
    <div aria-label={label} style={{ order }}>
      <div className={GRID_CLASS}>
        {products.map((p, i) => (
          <ProductResultCard
            key={p.productId}
            product={p}
            isBest={i === badgeAt}
            query={query}
            rank={(page - 1) * PAGE_SIZE + i}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={renderStartMs}
          />
        ))}
      </div>
    </div>
  );
}

/* One boundary per adapter flush: renders only the cards NEW in this snapshot.
   A card whose id already appeared in the immediately-prior snapshot keeps its
   slot and is not re-rendered (append-only over cumulative snapshots, AC-2).
   All values derive purely from the snapshot pair — no mutable accumulators —
   so flush order, hydration, and re-renders land on identical markup.

   REEA-189 Rule 2: under device intent each flush lands inside the Devices /
   Accessories stacked containers. `order` (Devices 1, Accessories 2) makes the
   stacking hold ACROSS flushes too — a device arriving late still stacks above
   accessories from earlier flushes — while every card keeps its slot inside
   its own container. Non-device queries keep the plain single block. */
function StageAppend(props: {
  stages: Promise<LiveSearchResult>[];
  index: number;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  renderStartMs?: number;
  locale?: Locale;
}) {
  const { stages, index, page, country, showOutOfStock } = props;
  const t = getStrings(props.locale ?? clientLocale());
  const snap = use(stages[index]);
  const visible = stagedView(snap, page, country, showOutOfStock);
  // Snapshots are cumulative, so comparing against the adjacent prior stage is
  // enough to isolate what this flush adds. At index 0 the "prior" is the
  // same stage — everything visible is fresh.
  const prevSnap = use(stages[Math.max(0, index - 1)]);
  const prevVisible = stagedView(prevSnap, page, country, showOutOfStock);
  const prevIds = new Set(prevVisible.map((p) => p.productId));
  const fresh = index === 0 ? visible : visible.filter((p) => !prevIds.has(p.productId));
  // REEA-222: badge ownership follows the first flush that actually RENDERS
  // cards, not index 0 blindly. When the earliest snapshots are empty under
  // the country/stock selections, the whole page used to render without any
  // Best-price badge (only index 0 could carry one). Same rule inside the
  // tiered path: the Accessories block owns the badge only when it is the
  // only rendered block up to here.
  const badgeOwner = index === 0 || prevVisible.length === 0;
  // The tier gate reads the FULL matched set (cumulative snapshot), so the
  // decision only ever flips toward tiering as more retailers answer.
  const tiered = partitionForQuery(visible).tiered;
  const next = index + 1 < stages.length ? (
    <Suspense fallback={null}>
      <StageAppend {...props} index={index + 1} />
    </Suspense>
  ) : null;

  if (!tiered) {
    return (
      <>
        <FlushBlock order={1} products={fresh} bestAt={badgeOwner ? 0 : -1} {...props} />
        {next}
      </>
    );
  }
  const devices = fresh.filter((p) => !isAccessoryTitle(p.title));
  const accessories = fresh.filter((p) => isAccessoryTitle(p.title));
  return (
    <>
      <FlushBlock
        label={t.devicesLabel}
        order={1}
        
        products={devices}
        bestAt={badgeOwner ? 0 : -1}
        {...props}
      />
      <FlushBlock label={t.accessoriesLabel} order={2} products={accessories} bestAt={badgeOwner && devices.length === 0 ? 0 : -1} {...props} />
      {next}
    </>
  );
}

/* REEA-332 item 2 — the count heading carries one hint line whenever its own
   count reads zero for a real query: "No matches — try a shorter phrase.",
   small text in the muted colour. Deriving the hint from the SAME count the
   heading renders keeps every view (streamed shell, converged staged view,
   plain fallback) on one rule — the hint appears exactly when the heading
   says zero, and one shared component keeps the markup identical across the
   three sites so hydration never forks. */
function CountHeading({ count, query, locale }: { count: number; query: string; locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <>
      {/* Theme v1 §4: display-scale H1, tabular count */}
      <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
        <span className="tabular">{count}</span>{" "}
        {count === 1 ? t.resultsOne : t.resultsMany} {t.resultsForWord} &ldquo;{query || t.allProducts}&rdquo;
      </h1>
      {count === 0 && query ? (
        <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>{t.emptyHint}</p>
      ) : null}
    </>
  );
}

/* REEA-224 item 2 — the `N results for …` h1 must be part of the initial
   server shell, not something that appears only when the view converges:
   without it the late heading pushes the footer down between first paint and
   the settled grid. This boundary resolves with the FIRST staged flush (the
   same promise StageAppend index 0 consumes), so the heading rides the first
   streamed chunk and only its count deepens as slower retailers land.

   REEA-437 AC-3 — while the count-so-far is still ZERO and more answers may
   land (later stages pending, or this snapshot is a finalized-at-budget
   provisional one with hops converging behind the response), the heading
   slot keeps its skeleton instead of flashing "0 results — No matches"
   before the cards arrive. A single settled stage answering zero is the
   honest final answer and renders straight away. */
function ResultsHeading(props: {
  stage: Promise<LiveSearchResult>;
  stagesCount: number;
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
}) {
  const snap = use(props.stage);
  const visible = stagedView(snap, props.page, props.country, props.showOutOfStock);
  if (visible.length === 0 && (props.stagesCount > 1 || snap.settled === false)) {
    return <HeadingGhost />;
  }
  return <CountHeading count={visible.length} query={props.query} locale={props.locale} />;
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
function CoverageLine({
  notes,
  products,
  locale,
}: {
  notes: LiveSearchResult["notes"];
  products: NormalizedProduct[];
  locale?: Locale;
}) {
  const text = coverageLine(notes, locale, products);
  if (!text) return null;
  return (
    <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
      {text}
    </p>
  );
}

function StageCoverage(props: {
  stage: Promise<LiveSearchResult>;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
}) {
  const snap = use(props.stage);
  // REEA-574 R1 — the contributor names are recomputed from the SAME filtered
  // rows this paint renders (country / out-of-stock selections included), so a
  // name in the sentence always has ≥1 visible offer row beside it.
  return (
    <CoverageLine
      notes={snap.notes}
      products={stagedView(snap, props.page, props.country, props.showOutOfStock)}
      locale={props.locale}
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
        if (alive) setFinalSnap(snap);
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
  // richer live snapshot replaces the finalized one; an equal, older, or
  // absent answer keeps what is already rendered. The coverage line re-renders
  // from the merged notes, so a merchant named as "no answer within budget"
  // moves to the answered side exactly when its offers appear.
  const followedQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (followedQueryRef.current === query) return;
    followedQueryRef.current = query;
    const controller = new AbortController();
    fetch(`/api/results-followup?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<LiveSearchResult | null>) : null))
      .then((late) => {
        if (!late || !Array.isArray(late.products)) return;
        setFinalSnap((current) =>
          late.products.length >= (current?.products.length ?? 0) ? late : current,
        );
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
  // half-count impression storms.
  const products = finalSnap ? stagedView(finalSnap, page, country, showOutOfStock) : null;
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
    ]);
  }, [eventsKey, query, page, products]);

  if (finalSnap && products) {
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
      return (
        <ResultsErrorBoundary locale={locale}>
          <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} />
          <HeadingGhost />
          <CoverageLine notes={finalSnap.notes} products={products} locale={locale} />
        </ResultsErrorBoundary>
      );
    }
    return (
      <ResultsErrorBoundary locale={locale}>
        <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} />
        <CountHeading count={products.length} query={query} locale={locale} />
        {products.length === 0 && query.length > 0 ? (
          <>
            <EmptyState query={query} suggestions={stagedSuggestions(finalSnap, country, showOutOfStock)} country={country} locale={locale} tries={finalSnap.attemptedQueries} />
            <CoverageLine notes={finalSnap.notes} products={products} locale={locale} />
          </>
        ) : (
          <>
            <CoverageLine notes={finalSnap.notes} products={products} locale={locale} />
            <ResultsGrid
              products={products}
              query={query}
              page={page}
              country={country}
              showOutOfStock={showOutOfStock} locale={locale}
              renderStartMs={props.renderStartMs}
            />
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
      <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} />
      <Suspense fallback={null}>
        <ResultsHeading
          // REEA-382 AC-1 — the count reads from the FINAL stage, the same
          // snapshot the appended flushes converge onto, so the delivered
          // document's heading number equals the rendered card count. Stage
          // zero used to feed it: the shell then kept a stage-one count while
          // later flushes kept stacking cards under it ("20 results" over a
          // 67-card grid at the nineteen-store set). The skeleton covers the
          // gap exactly like the REEA-437 zero case — the number that lands
          // is already true when it lands.
          stage={finalPromise}
          stagesCount={stages.length}
          query={query}
          page={page}
          country={country}
          showOutOfStock={showOutOfStock} locale={locale}
        />
      </Suspense>
      <Suspense fallback={null}>
        <StageCoverage
          stage={finalPromise}
          page={page}
          country={country}
          showOutOfStock={showOutOfStock}
          locale={locale}
        />
      </Suspense>
      <div className="flex min-w-0 flex-col items-stretch gap-4" style={{ marginTop: "var(--rc-space-8)" }}>
        <Suspense fallback={null}>
          <StageAppend
            stages={stages}
            index={0}
            query={query}
            page={page}
            country={country}
            showOutOfStock={showOutOfStock} locale={locale}
            renderStartMs={props.renderStartMs}
          />
        </Suspense>
      </div>
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
  const resolvedCountry =
    props.country ?? sanitizeCountry(searchParams.get("c")) ?? recallCountry() ?? browserHint ?? null;
  // REEA-186: same resolution chain as the country selection — server-resolved
  // value wins, then the URL, then the same-tab remembered choice; default is
  // hide out-of-stock listings (checkbox unchecked).
  const resolvedOos =
    props.showOutOfStock ??
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
  // catalog fallback. Same for the stock selection (REEA-186).
  const products = filterProductsByStock(
    filterProductsByCountry(served, country),
    showOutOfStock,
  );
  const matchCount = products.length;
  const zero = query.length > 0 && matchCount === 0;
  const suggestions = staged
    ? [] // the staged path derives suggestions from each snapshot
    : filterProductsByStock(
        filterProductsByCountry(
          props.suggestions ?? suggestProducts(query, PRODUCTS).map((m) => m.product),
          country,
        ),
        showOutOfStock,
      );
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
    ]);
  }, [staged, eventsKey, query, page, zero, matchCount, products]);

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
      />
    );
  }

  return (
    <ResultsErrorBoundary locale={locale}>
      <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} />
      {/* REEA-332 item 2: same heading + hint rule as the staged paths. */}
      <CountHeading count={products.length} query={query} locale={locale} />
      {zero ? (
        <EmptyState query={query} suggestions={suggestions} country={country} locale={locale} />
      ) : (
        <ResultsGrid
          products={products}
          query={query}
          page={page}
          country={country}
          showOutOfStock={showOutOfStock} locale={locale}
          renderStartMs={props.renderStartMs}
        />
      )}
    </ResultsErrorBoundary>
  );
}
