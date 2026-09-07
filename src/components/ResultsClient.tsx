"use client";

import { Component, Suspense, useEffect, useRef, useState, use, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import CountryFilter from "@/components/CountryFilter";
import StockToggle from "@/components/StockToggle";
import ProductResultCard from "@/components/ProductResultCard";
import { searchProducts, suggestProducts } from "@/lib/search";
import { sanitizePage, sanitizeSearchQuery } from "@/lib/search-params";
import {
  filterProductsByStock,
  recallShowOutOfStock,
  sanitizeShowOutOfStock,
} from "@/lib/stock";
import {
  buildResultsHref,
  filterProductsByCountry,
  recallCountry,
  sanitizeCountry,
  type CountryCode,
} from "@/lib/country";
import { trackEvents } from "@/lib/telemetry";
import { PRODUCTS } from "@/lib/feed";
import { isAccessoryTitle, partitionForQuery } from "@/lib/relevance";
import type { LiveSearchResult } from "@/lib/collect/live-search";
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
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          className="result-card"
          role="alert"
          style={{ borderLeft: "3px solid var(--rc-error)", background: "var(--rc-error-bg)" }}
        >
          <h2 style={{ font: "var(--rc-text-title)", color: "var(--rc-ink)" }}>
            Something went wrong
          </h2>
          <p className="mt-1" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
            We couldn&apos;t load the results. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-primary focusable mt-4 min-h-11 px-4"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* Brief v4 loading state: card-shaped ghosts with sheen + the slim amber
   pulse bar carrying the "checking stores" label — never a blank area. */
function SkeletonCard() {
  return (
    <div className="result-card" aria-hidden>
      <div className="skeleton-block h-5 w-2/3" />
      <div className="skeleton-block mt-2 h-4 w-1/3" />
      <div className="skeleton-block mt-4 h-7 w-32" />
      <div className="skeleton-block mt-4 h-12" />
      <div className="skeleton-block mt-2 h-12" />
    </div>
  );
}

export function LoadingFallback() {
  return (
    <div className="space-y-4">
      <div className="pulse-bar" aria-hidden>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        Checking live stores…
      </p>
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

/* Brief v4 empty state: single card echoing the query, suggested-query pills
   from the relaxed live collection, Retry. The query lives in the URL, so
   Retry never loses it. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

function EmptyState({
  query,
  suggestions,
  country,
}: {
  query: string;
  suggestions: NormalizedProduct[];
  country: CountryCode | null;
}) {
  const pills = suggestions.slice(0, 3).map((p) => p.title);
  while (pills.length < EXAMPLES.length && pills.length < 3) pills.push(EXAMPLES[pills.length]);
  return (
    <div className="result-card mx-auto w-full max-w-xl">
      <h2 style={{ font: "var(--rc-text-h2)", color: "var(--rc-ink)" }}>
        No matches for &ldquo;{query}&rdquo; yet
      </h2>
      <p className="mt-2" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        We check live stores — spelling matters. Try a suggested search below; your query stays
        in the box.
      </p>
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
        Retry
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
}: {
  products: NormalizedProduct[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
}) {
  const tier = partitionForQuery(products);
  if (!tier.tiered) {
    return (
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]"
        style={{ marginTop: "var(--rc-space-8)" }}
      >
        {products.map((p, i) => (
          <ProductResultCard
            key={p.productId}
            product={p}
            isBest={i === 0}
            query={query}
            rank={(page - 1) * PAGE_SIZE + i}
            country={country}
            showOutOfStock={showOutOfStock}
          />
        ))}
      </div>
    );
  }
  return (
    <>
      <div aria-label="Devices">
        <div
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]"
          style={{ marginTop: "var(--rc-space-8)" }}
        >
          {tier.devices.map((p, i) => (
            <ProductResultCard
              key={p.productId}
              product={p}
              isBest={i === 0}
              query={query}
              rank={(page - 1) * PAGE_SIZE + i}
              country={country}
              showOutOfStock={showOutOfStock}
            />
          ))}
        </div>
      </div>
      {tier.accessories.length > 0 && (
        <div aria-label="Accessories">
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
                showOutOfStock={showOutOfStock}
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
}) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ResultsInner {...props} />
    </Suspense>
  );
}

function SelectionRow({
  query,
  country,
  showOutOfStock,
}: {
  query: string;
  country: CountryCode | null;
  showOutOfStock: boolean;
}) {
  return (
    /* REEA-170: country pills above the list — same control for both the
       result list and the empty state, active choice echoed from the URL.
       REEA-186: stock selection beside the country pills — visible in both
       the result list and the empty state, same control. */
    <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: "var(--rc-space-4)" }}>
      <CountryFilter query={query} country={country} />
      <StockToggle query={query} country={country} showOutOfStock={showOutOfStock} />
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
}) {
  const { label, order, products, bestAt, query, page, country, showOutOfStock } = props;
  if (products.length === 0) return null;
  return (
    <div aria-label={label} style={{ order }}>
      <div className={GRID_CLASS}>
        {products.map((p, i) => (
          <ProductResultCard
            key={p.productId}
            product={p}
            isBest={i === bestAt}
            query={query}
            rank={(page - 1) * PAGE_SIZE + i}
            country={country}
            showOutOfStock={showOutOfStock}
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
}) {
  const { stages, index, query, page, country, showOutOfStock } = props;
  const snap = use(stages[index]);
  const visible = stagedView(snap, page, country, showOutOfStock);
  // Snapshots are cumulative, so comparing against the adjacent prior stage is
  // enough to isolate what this flush adds. At index 0 the "prior" promise is
  // this same stage — everything visible is fresh.
  const prevSnap = use(stages[Math.max(0, index - 1)]);
  const prevIds = new Set(
    stagedView(prevSnap, page, country, showOutOfStock).map((p) => p.productId),
  );
  const fresh = index === 0 ? visible : visible.filter((p) => !prevIds.has(p.productId));
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
        <FlushBlock order={1} products={fresh} bestAt={index === 0 ? 0 : -1} {...props} />
        {next}
      </>
    );
  }
  const devices = fresh.filter((p) => !isAccessoryTitle(p.title));
  const accessories = fresh.filter((p) => isAccessoryTitle(p.title));
  return (
    <>
      <FlushBlock
        label="Devices"
        order={1}
        
        products={devices}
        bestAt={index === 0 ? 0 : -1}
        {...props}
      />
      <FlushBlock label="Accessories" order={2}  products={accessories} bestAt={-1} {...props} />
      {next}
    </>
  );
}

function StagedResults(props: {
  stages: Promise<LiveSearchResult>[];
  query: string;
  page: number;
  country: CountryCode | null;
  showOutOfStock: boolean;
}) {
  const { stages, query, page, country, showOutOfStock } = props;
  const finalPromise = stages[stages.length - 1];
  const [finalSnap, setFinalSnap] = useState<LiveSearchResult | null>(null);

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
    return (
      <ResultsErrorBoundary>
        <SelectionRow query={query} country={country} showOutOfStock={showOutOfStock} />
        {products.length === 0 && query.length > 0 ? (
          <EmptyState query={query} suggestions={stagedSuggestions(finalSnap, country, showOutOfStock)} country={country} />
        ) : (
          <>
            {/* Theme v1 §4: display-scale H1, tabular count */}
            <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
              <span className="tabular">{products.length}</span>{" "}
              {products.length === 1 ? "result" : "results"} for &ldquo;{query || "all products"}&rdquo;
            </h1>
            <ResultsGrid
              products={products}
              query={query}
              page={page}
              country={country}
              showOutOfStock={showOutOfStock}
            />
          </>
        )}
      </ResultsErrorBoundary>
    );
  }

  // Streaming view: append-only flushes; count/empty state wait for the
  // converged snapshot so a partial arrival never reads as "no results".
  // REEA-189: the container is a flex column so flush blocks stack full-width
  // and the block `order` values (Devices 1 / Accessories 2) hold across
  // flushes — late devices still stack above earlier accessories.
  return (
    <ResultsErrorBoundary>
      <SelectionRow query={query} country={country} showOutOfStock={showOutOfStock} />
      <div className="flex min-w-0 flex-col items-stretch gap-4" style={{ marginTop: "var(--rc-space-8)" }}>
        <Suspense fallback={null}>
          <StageAppend
            stages={stages}
            index={0}
            query={query}
            page={page}
            country={country}
            showOutOfStock={showOutOfStock}
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
}) {
  const searchParams = useSearchParams();
  // AC-U4 (REEA-13): malformed/oversized params degrade safely before use.
  const query = props.query ?? sanitizeSearchQuery(searchParams.get("q")) ?? "";
  const page = props.page ?? sanitizePage(searchParams.get("page"));
  // REEA-170: the server-resolved selection wins; otherwise read the URL, then
  // the same-tab remembered choice so a returning tab keeps its filter
  // without re-selecting. null = "All" = unchanged default behavior.
  const country =
    props.country ?? sanitizeCountry(searchParams.get("c")) ?? recallCountry() ?? null;
  // REEA-186: same resolution chain as the country selection — server-resolved
  // value wins, then the URL, then the same-tab remembered choice; default is
  // hide out-of-stock listings (checkbox unchecked).
  const showOutOfStock =
    props.showOutOfStock ??
    sanitizeShowOutOfStock(searchParams.get("oos")) ??
    recallShowOutOfStock() ??
    false;

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
        showOutOfStock={showOutOfStock}
      />
    );
  }

  return (
    <ResultsErrorBoundary>
      <SelectionRow query={query} country={country} showOutOfStock={showOutOfStock} />
      {zero ? (
        <EmptyState query={query} suggestions={suggestions} country={country} />
      ) : (
        <>
          {/* Theme v1 §4: display-scale H1, tabular count */}
          <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
            <span className="tabular">{products.length}</span>{" "}
            {products.length === 1 ? "result" : "results"} for &ldquo;{query || "all products"}&rdquo;
          </h1>
          <ResultsGrid
            products={products}
            query={query}
            page={page}
            country={country}
            showOutOfStock={showOutOfStock}
          />
        </>
      )}
    </ResultsErrorBoundary>
  );
}
