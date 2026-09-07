"use client";

import { Component, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ProductResultCard from "@/components/ProductResultCard";
import { searchProducts, suggestProducts } from "@/lib/search";
import { sanitizePage, sanitizeSearchQuery } from "@/lib/search-params";
import { trackEvents } from "@/lib/telemetry";
import { PRODUCTS } from "@/lib/feed";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-114: the results surface renders EXACTLY what the server collected at
 * query time (see src/app/results/page.tsx) — offers/titles/coupons/stock and
 * the freshness chips all ride on the passed-in products. No client-side
 * fallback array: hydration reuses the served data; a new query re-runs the
 * server collection through the router.
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
}: {
  query: string;
  suggestions: NormalizedProduct[];
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
          <Link
            key={q}
            href={`/results?q=${encodeURIComponent(q)}`}
            className="query-pill query-pill-on-light"
          >
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

export default function ResultsClient(props: {
  /** Server-collected live set (REEA-114). Absent props fall back to the
   *  client-side feed read so tests and the static-export host still work. */
  query?: string;
  page?: number;
  products?: NormalizedProduct[];
  suggestions?: NormalizedProduct[];
}) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ResultsInner {...props} />
    </Suspense>
  );
}

function ResultsInner(props: {
  query?: string;
  page?: number;
  products?: NormalizedProduct[];
  suggestions?: NormalizedProduct[];
}) {
  const searchParams = useSearchParams();
  // AC-U4 (REEA-13): malformed/oversized params degrade safely before use.
  const query = props.query ?? sanitizeSearchQuery(searchParams.get("q")) ?? "";
  const page = props.page ?? sanitizePage(searchParams.get("page"));
  const matched = props.products ? [] : query ? searchProducts(query, PRODUCTS) : [];
  const matchCount = props.products ? props.products.length : matched.length;
  const allProducts =
    props.products ?? (matched.length > 0 ? matched.map((m) => m.product) : PRODUCTS);
  const products = props.products
    ? allProducts // server already paginated
    : allProducts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const zero = query.length > 0 && matchCount === 0;
  const suggestions =
    props.suggestions ?? suggestProducts(query, PRODUCTS).map((m) => m.product);
  // REEA-37: funnel instrumentation — search_submitted (+ zero_results) and
  // result_impressed fire once per (query, page, result-set). Dedup key is
  // component-local memory only; nothing is persisted client-side.
  const eventsKey = `${query}|${page}|${matchCount}`;
  const sentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!query || sentKeyRef.current === eventsKey) return;
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
  }, [eventsKey, query, page, zero, matchCount, products]);

  return (
    <ResultsErrorBoundary>
      {zero ? (
        <EmptyState query={query} suggestions={suggestions} />
      ) : (
        <>
          {/* Theme v1 §4: display-scale H1, tabular count */}
          <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
            <span className="tabular">{products.length}</span>{" "}
            {products.length === 1 ? "result" : "results"} for &ldquo;{query || "all products"}&rdquo;
          </h1>
          {/* Design v3 §5.2: single-column list, two columns only ≥1280px.
              minmax(0,1fr) tracks keep long product titles from widening the
              grid past the viewport at 375px (smoke step 5). */}
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
              />
            ))}
          </div>
        </>
      )}
    </ResultsErrorBoundary>
  );
}
