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

/* Brief v4 loading state: 3 card-shaped ghosts with sheen + the slim amber
   pulse bar carrying a retailer-count label — never a blank area. */
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

function LoadingFallback() {
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

/* Theme v1 §3.5 error state: error-bg card with 3px error left border + Retry. */
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
            onClick={() => this.setState({ failed: false })}
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

/* Brief v4 empty state: single card echoing the query, one plain sentence,
   2–3 suggested-query pills and Retry. The query itself always stays in the
   header input (it lives in the URL), so Retry never loses it. */
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

function Results() {
  const searchParams = useSearchParams();
  // AC-U4 (REEA-13): malformed/oversized params degrade safely before use.
  const query = sanitizeSearchQuery(searchParams.get("q")) ?? "";
  const page = sanitizePage(searchParams.get("page"));
  const matches = query ? searchProducts(query, PRODUCTS) : [];

  // REEA-37: funnel instrumentation — search_submitted (+ zero_results) and
  // result_impressed fire once per (query, page, result-set) render.
  // Dedup key is component-local memory only; nothing is persisted client-side.
  const allProducts = matches.length > 0 ? matches.map((m) => m.product) : PRODUCTS;
  const PAGE_SIZE = 20;
  const products = allProducts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const zero = query && matches.length === 0;
  const eventsKey = `${query}|${page}|${matches.length}`;
  const sentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!query || sentKeyRef.current === eventsKey) return;
    sentKeyRef.current = eventsKey;
    trackEvents([
      { type: "search_submitted", query, result_count: matches.length },
      ...(zero ? [{ type: "zero_results" as const, query }] : []),
      ...products.map((p, i) => ({
        type: "result_impressed" as const,
        query,
        rank: (page - 1) * PAGE_SIZE + i,
        item_id: p.productId,
      })),
    ]);
  }, [eventsKey, query, page, zero, matches.length, products]);

  if (zero) {
    const suggestions = suggestProducts(query, PRODUCTS).map((m) => m.product);
    return <EmptyState query={query} suggestions={suggestions} />;
  }

  return (
    <>
      {/* Theme v1 §4: display-scale H1, tabular count */}
      <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
        <span className="tabular">{products.length}</span>{" "}
        {products.length === 1 ? "result" : "results"} for &ldquo;{query || "all products"}&rdquo;
      </h1>
      {/* Design v3 §5.2: single-column list, two columns only ≥1280px.
          minmax(0,1fr) tracks keep long product titles from widening the grid
          past the viewport at 375px (smoke step 5). */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[repeat(2,minmax(0,1fr))]" style={{ marginTop: "var(--rc-space-8)" }}>
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
  );
}

export default function ResultsClient() {
  return (
    <ResultsErrorBoundary>
      <Suspense fallback={<LoadingFallback />}>
        <Results />
      </Suspense>
    </ResultsErrorBoundary>
  );
}
