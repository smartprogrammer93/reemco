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

/* Theme v1 §3.5 loading state: 3 skeleton cards, 1.2s pulse — never a blank page. */
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
          style={{ borderLeft: "3px solid var(--color-error)", background: "var(--color-error-bg)" }}
        >
          <h2 style={{ font: "var(--text-title)", color: "var(--color-ink)" }}>
            Something went wrong
          </h2>
          <p className="mt-1" style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
            We couldn&apos;t load the results. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className="btn-primary focusable mt-4 h-10 px-4"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* Theme v1 §3.5 no-results state: title, suggestion line, 3 example links. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

function EmptyState({
  query,
  suggestions,
}: {
  query: string;
  suggestions: NormalizedProduct[];
}) {
  return (
    <div className="text-center" style={{ padding: "var(--space-12) 0" }}>
      <h2 style={{ font: "var(--text-title)", color: "var(--color-ink)" }}>
        No results for &ldquo;{query}&rdquo;
      </h2>
      <p className="mt-2" style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
        {suggestions.length > 0
          ? "Did you mean one of these?"
          : "Check the spelling or try a shorter brand name."}
      </p>
      {suggestions.length > 0 && (
        <ul className="mx-auto mt-4 w-full max-w-md space-y-2 text-left">
          {suggestions.map((p) => (
            <li key={p.productId} className="result-card px-4 py-3">
              <Link
                href={`/results?q=${encodeURIComponent(p.title)}`}
                className="hover:underline"
                style={{ font: "var(--text-body)", fontWeight: 500, color: "var(--color-primary)" }}
              >
                {p.title}
              </Link>
              <p className="tabular" style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)" }}>
                {p.brand} · from{" "}
                {Math.min(...p.offers.map((o) => o.price)).toFixed(2)}{" "}
                {p.offers[0]?.currency ?? "KWD"}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-center gap-4" style={{ marginTop: "var(--space-4)" }}>
        {EXAMPLES.map((q) => (
          <Link
            key={q}
            href={`/results?q=${encodeURIComponent(q)}`}
            className="hover:underline"
            style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
          >
            {q}
          </Link>
        ))}
      </div>
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
      <h1 style={{ font: "var(--text-display)", color: "var(--color-ink)" }}>
        <span className="tabular">{products.length}</span> results for &ldquo;{query || "all products"}&rdquo;
      </h1>
      <div className="space-y-4" style={{ marginTop: "var(--space-8)" }}>
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
