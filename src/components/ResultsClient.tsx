"use client";

import { Component, Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ProductResultCard from "@/components/ProductResultCard";
import { searchProducts, suggestProducts } from "@/lib/search";
import { sanitizePage, sanitizeSearchQuery } from "@/lib/search-params";
import { PRODUCTS } from "@/lib/feed";
import type { NormalizedProduct } from "@/types/product";

/* F8 loading state: skeleton cards, 1.2s pulse */
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

/* F8 error state: text #B42318, secondary Retry button */
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
        <div className="result-card flex flex-col items-center py-12 text-center">
          <h2 className="text-[20px] font-semibold leading-[26px]" style={{ color: "var(--brand-red)" }}>
            Something went wrong
          </h2>
          <p className="mt-2 text-sm" style={{ color: "var(--brand-slate-600)" }}>
            We couldn&apos;t load the results. Please try again.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className="mt-6 h-8 rounded px-4 text-sm font-medium text-white"
            style={{ background: "var(--brand-red)" }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* F8 empty state: 48px icon in green-tint circle, title, body, primary blue button.
   Shows nearest-match suggestions so an unmatched query is never a dead end. */
function EmptyState({
  query,
  suggestions,
}: {
  query: string;
  suggestions: NormalizedProduct[];
}) {
  return (
    <div className="result-card flex flex-col items-center py-12 text-center">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full text-2xl"
        style={{ background: "var(--brand-green-tint)" }}
        aria-hidden
      >
        🔍
      </span>
      <h2 className="mt-4 text-[20px] font-semibold leading-[26px]" style={{ color: "var(--brand-ink)" }}>
        No results for &ldquo;{query}&rdquo;
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--brand-slate-600)" }}>
        {suggestions.length > 0
          ? "Did you mean one of these?"
          : "Try a different product name or brand."}
      </p>
      {suggestions.length > 0 && (
        <ul className="mt-4 w-full max-w-md space-y-2 text-left">
          {suggestions.map((p) => (
            <li key={p.productId} className="result-card px-4 py-3">
              <Link href={`/results?q=${encodeURIComponent(p.title)}`} className="text-sm font-medium hover:underline" style={{ color: "var(--brand-blue)" }}>
                {p.title}
              </Link>
              <p className="text-xs" style={{ color: "var(--brand-slate-600)" }}>
                {p.brand} · from{" "}
                {Math.min(...p.offers.map((o) => o.price)).toFixed(2)}{" "}
                {p.offers[0]?.currency ?? "KWD"}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/search"
        className="mt-6 flex h-8 items-center rounded px-4 text-sm font-medium text-white"
        style={{ background: "var(--brand-blue)" }}
      >
        Search again
      </Link>
    </div>
  );
}

function Results() {
  const searchParams = useSearchParams();
  // AC-U4 (REEA-13): malformed/oversized params degrade safely before use.
  const query = sanitizeSearchQuery(searchParams.get("q")) ?? "";
  const page = sanitizePage(searchParams.get("page"));
  const matches = query ? searchProducts(query, PRODUCTS) : [];

  if (query && matches.length === 0) {
    const suggestions = suggestProducts(query, PRODUCTS).map((m) => m.product);
    return <EmptyState query={query} suggestions={suggestions} />;
  }

  const allProducts = matches.length > 0 ? matches.map((m) => m.product) : PRODUCTS;
  // Page pagination is bounded by sanitizePage (MAX_PAGE); slice defensively.
  const PAGE_SIZE = 20;
  const products = allProducts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div className="space-y-4">
      {products.map((p) => (
        <ProductResultCard key={p.productId} product={p} />
      ))}
    </div>
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
