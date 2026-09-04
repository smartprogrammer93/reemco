"use client";

import { Component, Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ProductResultCard from "@/components/ProductResultCard";
import { STUB_PRODUCTS, filterProducts } from "@/lib/feed";

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

/* F8 empty state: 48px icon in green-tint circle, title, body, primary blue button */
function EmptyState({ query }: { query: string }) {
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
        Try a different product name or brand.
      </p>
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
  const query = searchParams.get("q") ?? "";
  const products = query ? filterProducts(STUB_PRODUCTS, query) : STUB_PRODUCTS;

  if (products.length === 0) {
    return <EmptyState query={query} />;
  }

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
