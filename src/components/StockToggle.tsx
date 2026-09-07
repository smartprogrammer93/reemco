"use client";

import Link from "next/link";
import { buildResultsHref, type CountryCode } from "@/lib/country";
import { rememberShowOutOfStock } from "@/lib/stock";

/**
 * REEA-186 — "Show out-of-stock items" checkbox on the results surface. Same
 * mechanism as the REEA-170 pills: the selection rides the URL (`?oos=1`) as a
 * plain link, so enabling/disabling re-collects live under the new selection;
 * unchecked drops the param and the default (hide out-of-stock) applies.
 * Checkbox semantics on the link: aria-checked mirrors the state and the box
 * glyph shows it. Clicking records the choice in the same-tab slot so the next
 * search from the header form carries it without re-selecting. Selection
 * changes reset to page 1 — the visible set is a different result set.
 */
export default function StockToggle({
  query,
  country,
  showOutOfStock,
}: {
  query: string;
  country: CountryCode | null;
  showOutOfStock: boolean;
}) {
  const next = !showOutOfStock;
  return (
    <Link
      href={buildResultsHref(query, 1, country, next)}
      onClick={() => rememberShowOutOfStock(next)}
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
    </Link>
  );
}
