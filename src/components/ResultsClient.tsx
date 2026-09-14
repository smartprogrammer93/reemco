"use client";

import { Component, Suspense, useEffect, useMemo, useRef, useState, use, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import CountryFilter from "@/components/CountryFilter";
import StockToggle from "@/components/StockToggle";
import ProductResultCard from "@/components/ProductResultCard";
import { searchProducts } from "@/lib/search";
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
import { HeadingGhost, SkeletonCard, StampGhost, coverageLhTier } from "@/components/SkeletonSlots";
import { PRODUCTS } from "@/lib/feed";
import { exactSkuKeep } from "@/lib/relevance";
import { partitionByConfidence } from "@/lib/confidence";
import { formatPrice } from "@/lib/format";
import SearchForm from "@/components/SearchForm";
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
   — honesty cuts both ways. */
function EmptyState({
  query,
  unavailable,
  country,
  locale,
  tries,
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
}) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="result-card empty-state mx-auto w-full max-w-xl" data-empty-state="true">
      <h2 style={{ font: "var(--rc-text-h2)", color: "var(--rc-ink)" }}>{t.emptyTitle}</h2>
      <p className="mt-2" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.emptyBody}
      </p>
      {unavailable ? (
        <p className="mt-2" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          {t.emptyUnavailable}
        </p>
      ) : null}
      {tries && tries.length > 0 ? (
        <p className="mt-2" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {fill(t.triedForms, { tries: tries.join('”, “') })}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {[t.emptyExample1, t.emptyExample2, t.emptyExample3].map((q) => (
          <Link key={q} href={buildResultsHref(q, 1, country)} className="query-pill query-pill-on-light">
            {q}
          </Link>
        ))}
      </div>
      {/* FR-1.2 — the failed query pre-filled; retry is one keystroke away. */}
      <div className="mt-4">
        <SearchForm defaultValue={query} country={country} locale={locale} />
      </div>
    </div>
  );
}

/* REEA-964 FR-2 — the related-accessories band: the SECOND section of the
   results page, always clearly labeled "not an exact match", capped at
   RELATED_CAP (6), visually subordinate (compact rows, muted band styling —
   visual polish belongs to the Graphic Designer). Never renders as peer
   cards inside primary results. */
function RelatedBand({ items, locale }: { items: NormalizedProduct[]; locale?: Locale }) {
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
}) {
  const t = getStrings(locale ?? clientLocale());
  const bestAt = bestBadgeIndex(products);
  return (
    <section aria-label={t.primaryResultsAria} data-primary-section="true">
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]"
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
    /* REEA-945 — named hook for the ≤375px compaction block in globals.css:
       on SE-class widths the row becomes one horizontally scrollable line
       instead of wrapping to 3-4 lines above the results. */
    <div
      className="selection-row flex flex-wrap items-center gap-2"
      style={{ marginBottom: "var(--rc-space-4)" }}
    >
      <CountryFilter country={country} onSelect={onSelectCountry} locale={locale} />
      <StockToggle showOutOfStock={showOutOfStock} locale={locale} onToggle={onToggleStock} />
      <button type="button" onClick={onRefresh} className="query-pill query-pill-on-light focusable">
        {t.refresh}
      </button>
    </div>
  );
}

/* Selections apply BEFORE slicing, per snapshot — same chain (country, then
   stock) the plain path runs, so staged and converged views agree. REEA-822:
   the exact-SKU keep-predicate rides the stock stage so the code-matched card
   survives the default OOS card-level drop (its all-OOS offer set renders
   honestly as out-of-stock instead of erasing the lead into a fake zero). */
/* Selections apply BEFORE the confidence partition, per snapshot — same chain
   (country, then stock) the plain path runs, so staged and converged views
   agree. REEA-964: the partition splits the filtered set into primary
   (confident) and related (below threshold, capped) — the page slice applies
   to the PRIMARY list only; the related band is capped by the partition
   itself, on every page. REEA-822: the exact-SKU keep-predicate rides the
   stock stage so the code-matched card survives the default OOS card-level
   drop (its all-OOS offer set renders honestly as out-of-stock instead of
   erasing the lead into a fake zero). */
function stagedSections(
  snap: LiveSearchResult,
  query: string,
  country: CountryCode | null,
  showOutOfStock: boolean,
): { primary: NormalizedProduct[]; related: NormalizedProduct[] } {
  const filtered = filterProductsByStock(
    filterProductsByCountry(snap.products, country),
    showOutOfStock,
    exactSkuKeep(query),
  );
  return partitionByConfidence(query, filtered);
}

function stagedView(
  snap: LiveSearchResult,
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock: boolean,
): NormalizedProduct[] {
  return stagedSections(snap, query, country, showOutOfStock).primary.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );
}

/* Design v3 grid inside one streaming block (see StageAppend). */
const GRID_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]";

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
}) {
  const { products, bestAt, query, page, country, showOutOfStock, renderStartMs, locale, kuwaitBatchPending, kuwaitPendingStatus } = props;
  if (products.length === 0) return null;
  // REEA-213: inside a participating block the badge rides the first
  // in-stock card of the final sorted order, never a later cheaper one.
  const badgeAt = bestAt < 0 ? -1 : bestBadgeIndex(products);
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

   REEA-964: flushes render CONFIDENT (primary) cards only; the related band
   is a separate final-stage boundary (StageEmptyState below), so a
   below-threshold row can never append into the primary flow mid-stream. */
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
  const snap = use(stages[index]);
  const visible = stagedView(snap, props.query, page, country, showOutOfStock);
  // Snapshots are cumulative, so comparing against the adjacent prior stage is
  // enough to isolate what this flush adds. At index 0 the "prior" is the
  // same stage — everything visible is fresh.
  const prevSnap = use(stages[Math.max(0, index - 1)]);
  const prevVisible = stagedView(prevSnap, props.query, page, country, showOutOfStock);
  const prevIds = new Set(prevVisible.map((p) => p.productId));
  const fresh = index === 0 ? visible : visible.filter((p) => !prevIds.has(p.productId));
  // REEA-222: badge ownership follows the first flush that actually RENDERS
  // cards, not index 0 blindly. When the earliest snapshots are empty under
  // the country/stock selections, the whole page used to render without any
  // Best-price badge (only index 0 could carry one).
  const badgeOwner = index === 0 || prevVisible.length === 0;
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
  const next = index + 1 < stages.length ? (
    <Suspense fallback={null}>
      <StageAppend {...props} index={index + 1} />
    </Suspense>
  ) : null;

  return (
    <>
      <FlushBlock products={fresh} bestAt={badgeOwner ? 0 : -1} kuwaitBatchPending={kuwaitBatchPending} kuwaitPendingStatus={kuwaitPendingStatus} {...props} />
      {next}
    </>
  );
}

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
   land (this snapshot is a finalized-at-budget provisional one with hops
   converging behind the response), the heading slot keeps its skeleton
   instead of flashing "0 results — No matches" before the cards arrive.

   REEA-721 follow-up (QA grade item 5) — once the FINAL snapshot SETTLES at
   zero the answer is honest and final: the served document itself carries
   `0 results for …` plus CountHeading's hint line, so a no-match state
   reads as an explicit empty result even before hydration — not just the
   filter row over empty space. The provisional guard still speaks through
   `settled === false`, which is exactly the finalized-at-budget shape. */
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
  const visible = stagedView(snap, props.query, props.page, props.country, props.showOutOfStock);
  if (visible.length === 0 && snap.settled === false) {
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
  pendingStatus,
  onRefresh,
}: {
  notes: LiveSearchResult["notes"];
  products: NormalizedProduct[];
  locale?: Locale;
  pendingStatus?: boolean;
  onRefresh?: () => void;
}) {
  const text = coverageLine(notes, locale, products);
  if (!text && !pendingStatus) return null;
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
      className={`meta-stamp coverage-line${pendingStatus ? " has-status" : ""}`}
      style={{ color: "var(--rc-muted)", minHeight: `${coverageLhTier(locale)}lh` }}
    >
      {text}
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
   settled at zero confident matches — not only after hydration. A
   finalized-at-budget zero stays provisional (null here; the REEA-437 heading
   ghost covers the gap until the follow-up feed answers). */
function StageEmptyState(props: {
  stages: readonly Promise<LiveSearchResult>[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
}) {
  const snap = use(props.stages[props.stages.length - 1]);
  if (props.query.length === 0 || snap.settled === false) return null;
  const sections = stagedSections(snap, props.query, props.country, props.showOutOfStock);
  if (sections.primary.length > 0) return null;
  // E6 — zero offers because the merchants errored (not a real empty shelf)
  // says so, instead of implying a no-match. Requires zero related rows too:
  // with related items the page is "near match", not an outage story.
  const sawErrors = snap.notes.some((n) => typeof n.error === "string");
  return (
    <>
      <EmptyState
        query={props.query}
        unavailable={sections.related.length === 0 && sawErrors}
        country={props.country}
        locale={props.locale}
        tries={snap.attemptedQueries}
      />
      <RelatedBand items={sections.related} locale={props.locale} />
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
      stage.then((snap) => {
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

function StageCoverage(props: {
  stages: readonly Promise<LiveSearchResult>[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
  locale?: Locale;
  onRefresh?: () => void;
}) {
  const snap = use(props.stages[props.stages.length - 1]);
  const products = use(
    useMemo(
      () => renderedAcrossStages(props.stages, props.query, props.page, props.country, props.showOutOfStock),
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
      locale={props.locale}
      pendingStatus={snap.kuwaitPendingStatus}
      onRefresh={props.onRefresh}
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
  // half-count impression storms. REEA-964: the count is the PRIMARY
  // (confident) set — the related band is not a result.
  const finalSections = finalSnap
    ? stagedSections(finalSnap, query, country, showOutOfStock)
    : null;
  const products = finalSections
    ? finalSections.primary.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    : null;
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
      return (
        <ResultsErrorBoundary locale={locale}>
          <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} />
          <HeadingGhost />
          {/* REEA-793 — pending row ahead of the stamp boundary in this view too. */}
          <Suspense fallback={null}>
            <StagePendingRow stages={stages} locale={locale} />
          </Suspense>
          <CoverageLine notes={finalSnap.notes} products={products} locale={locale} />
        </ResultsErrorBoundary>
      );
    }
    return (
      <ResultsErrorBoundary locale={locale}>
        <SelectionRow country={country} showOutOfStock={showOutOfStock} locale={locale} onSelectCountry={onSelectCountry} onToggleStock={onToggleStock} onRefresh={onRefresh} />
        <CountHeading count={products.length} query={query} locale={locale} />
        {/* REEA-793 B1 — the pending row sits DIRECTLY UNDER the count line
            in the converged view, before the coverage stamp. */}
        {finalSnap.deviceLeadPending ? <DeviceLeadPendingRow locale={locale} /> : null}
        {products.length === 0 && query.length > 0 ? (
          <>
            {/* REEA-964 — the honest empty state rides the primary position;
                the related band renders BELOW it, clearly not a result. */}
            <EmptyState
              query={query}
              unavailable={
                finalSections.related.length === 0 &&
                finalSnap.notes.some((n) => typeof n.error === "string")
              }
              country={country}
              locale={locale}
              tries={finalSnap.attemptedQueries}
            />
            <RelatedBand items={finalSections.related} locale={locale} />
            <CoverageLine notes={finalSnap.notes} products={products} locale={locale} />
          </>
        ) : (
          <>
            <CoverageLine notes={finalSnap.notes} products={products} locale={locale} pendingStatus={finalSnap.kuwaitPendingStatus} onRefresh={onRefresh} />
            <ResultsGrid
              products={products}
              query={query}
              page={page}
              country={country}
              showOutOfStock={showOutOfStock} locale={locale}
              renderStartMs={props.renderStartMs}
              /* REEA-835/847 — batch-pending only while the Kuwait batch may
                  still land: a finalized-at-budget snapshot clears when the
                  follow-up feed has answered (the REEA-437 one-shot grammar);
                  a converged snapshot was never pending. The card decides the
                  withhold on its own flagged offer (zero Kuwait-primary
                  rendered, or the lead is non-KWD — REEA-847). */
              kuwaitBatchPending={finalSnap.settled === false && !feedDone}
              kuwaitPendingStatus={finalSnap.kuwaitPendingStatus === true}
            />
            <RelatedBand items={finalSections.related} locale={locale} />
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
      {/* REEA-778 check 2 — the heading/stamp reserves ride the FIRST
          streamed flush: the boundaries carry the shared SkeletonSlots
          ghosts as their fallback markup, so the served document paints
          heading-slot + coverage-line boxes before either boundary swaps,
          and the settled heading/stamp land in-slot instead of pushing the
          already-painted card grid down (~79px on the old null fallback). */}
      <Suspense fallback={<HeadingGhost />}>
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
        />
      </Suspense>
      <div className="flex min-w-0 flex-col items-stretch gap-4" style={{ marginTop: "var(--rc-space-8)" }}>
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
  // catalog fallback. Same for the stock selection (REEA-186); REEA-822 adds
  // the exact-SKU keep so the fallback path matches the staged view's rule.
  // REEA-964: the confidence partition rides the SAME filtered set on the
  // fallback path — primary results vs the capped related band — so the
  // static-host view obeys the two-section contract too.
  const plainSections = partitionByConfidence(
    query,
    filterProductsByStock(
      filterProductsByCountry(served, country),
      showOutOfStock,
      exactSkuKeep(query),
    ),
  );
  const products = plainSections.primary;
  const matchCount = products.length;
  const zero = query.length > 0 && matchCount === 0;
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
        <>
          <EmptyState query={query} country={country} locale={locale} />
          <RelatedBand items={plainSections.related} locale={locale} />
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
          />
          <RelatedBand items={plainSections.related} locale={locale} />
        </>
      )}
    </ResultsErrorBoundary>
  );
}
