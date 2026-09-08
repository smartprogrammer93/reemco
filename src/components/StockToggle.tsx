"use client";

import { rememberShowOutOfStock } from "@/lib/stock";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-186 — "Show out-of-stock items" checkbox on the results surface. Same
 * mechanism as the REEA-170 pills. REEA-291 AC4: the toggle is an IN-PLACE
 * control — clicking flips the selection against the already-loaded offer
 * payload on the client, with no navigation and no second network round-trip
 * (the live re-collection stays behind the explicit Refresh action). The
 * click still records the choice in the same-tab slot so the next search from
 * the header form carries it without re-selecting. Checkbox semantics on the
 * control: aria-checked mirrors the state and the box glyph shows it.
 * Selection changes reset to page 1 — the visible set is a different result
 * set. Offers always stay live-collected; this only selects among what the
 * last live fetch returned.
 */
export default function StockToggle({
  showOutOfStock,
  onToggle,
  locale,
}: {
  showOutOfStock: boolean;
  /** Applied to the loaded payload immediately (AC4). */
  onToggle: (next: boolean) => void;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const next = !showOutOfStock;
  return (
    <button
      type="button"
      onClick={() => {
        rememberShowOutOfStock(next);
        onToggle(next);
      }}
      role="checkbox"
      aria-checked={showOutOfStock}
      className="query-pill query-pill-on-light focusable inline-flex items-center gap-2"
    >
      <span
        aria-hidden
        className="inline-flex h-4 w-4 items-center justify-center rounded border text-center"
        style={{
          borderColor: "var(--rc-line)",
          background: showOutOfStock ? "var(--rc-primary)" : "transparent",
          color: showOutOfStock ? "var(--rc-on-primary, #fff)" : "transparent",
          font: "var(--rc-text-small)",
          lineHeight: 1,
        }}
      >
        ✓
      </span>
      Show out-of-stock items
    </button>
  );
}
