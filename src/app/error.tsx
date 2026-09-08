"use client";

import { clientLocale, getStrings } from "@/lib/i18n";

/* Brief v4 error state: inline card (no overlay), plain human message; Retry
 * re-runs with the same URL, so the query survives exactly. */
export default function GlobalRouteError({ reset }: { error: Error; reset: () => void }) {
  const t = getStrings(clientLocale());
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
          {t.errorTitle}
        </h2>
        <p className="mt-1" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          {t.errorBody}
        </p>
        <button type="button" onClick={reset} className="btn-primary focusable mt-4 min-h-11 px-4">
          {t.retry}
        </button>
      </div>
    </div>
  );
}
