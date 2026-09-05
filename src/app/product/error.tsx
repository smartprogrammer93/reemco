"use client";

import ProductResultCard from "@/components/ProductResultCard";

export default function ProductError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--layout-max-w)" }}
    >
      <div
        className="result-card"
        role="alert"
        style={{ borderLeft: "3px solid var(--color-error)", background: "var(--color-error-bg)" }}
      >
        <h2 style={{ font: "var(--text-title)", color: "var(--color-ink)" }}>
          Something went wrong
        </h2>
        <p className="mt-1" style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
          We couldn&apos;t load this product. Please try again.
        </p>
        <button type="button" onClick={reset} className="btn-primary focusable mt-4 h-10 px-4">
          Retry
        </button>
      </div>
    </div>
  );
}
