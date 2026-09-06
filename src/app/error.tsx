"use client";

/* Theme v1 §3.5: route-level error card; header/footer come from the layout. */
export default function GlobalRouteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      <div
        className="result-card"
        role="alert"
        style={{ borderLeft: "3px solid var(--rc-error)", background: "var(--rc-error-bg)" }}
      >
        <h2 style={{ font: "var(--rc-text-title)", color: "var(--rc-ink)" }}>
          Something went wrong
        </h2>
        <p className="mt-1" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          An unexpected error occurred. Please try again.
        </p>
        <button type="button" onClick={reset} className="btn-primary focusable mt-4 h-10 px-4">
          Retry
        </button>
      </div>
    </div>
  );
}
