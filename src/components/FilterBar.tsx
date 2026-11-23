"use client";

import { rememberCountry, type CountryCode } from "@/lib/country";
import { rememberShowOutOfStock } from "@/lib/stock";
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-1069 — Direction A filter/market bar (REEA-1055 spec §3, AC3).
 *
 * SIX controls in one bar: All / Kuwait / Saudi / Egypt / In stock / Refresh.
 * At 375 they lay out 3 per row across two rows (never more), every control is
 * 44x44, and the selected state carries a check icon + aria-pressed="true" +
 * the tint/primary border — distinguishable without colour (the check glyph
 * and the pressed state are the non-colour signal).
 *
 * Selections stay IN-PLACE client filters over the already-loaded live payload
 * (REEA-291 AC4): no navigation, no second collection. Refresh is the one
 * explicit action that re-runs the live collection. Offers always stay
 * live-collected; this only selects among what the last live fetch returned.
 *
 * REEA-1114 AC3 — an active filter that is hiding matches says so on its own
 * chip ("In stock · 4 hidden" / "متوفر · 4 مخفية"), so the dead end is visible
 * BEFORE the shopper reaches the empty state. The count is derived from the
 * already-loaded payload by lib/hidden-matches.ts; no extra fetch, no server
 * field. At ≤640 the word is dropped and only the count badge renders, so the
 * 3-per-row grid never clips (AC5).
 */

/** The chip's hidden-match count. The word is CSS-hidden at 375 (AC5). */
function ChipHiddenCount({ count, locale }: { count: number; locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <span className="rc-chip-count">
      <span aria-hidden className="rc-chip-sep">
        {" · "}
      </span>
      <span>{count}</span>
      <span className="rc-chip-hidden-suffix"> {t.chipHiddenWord}</span>
    </span>
  );
}

export default function FilterBar({
  country,
  showOutOfStock,
  onSelectCountry,
  onToggleStock,
  onRefresh,
  locale,
  hiddenByStock = 0,
  hiddenByCountry = 0,
}: {
  country: CountryCode | null;
  showOutOfStock: boolean;
  onSelectCountry: (code: CountryCode | null) => void;
  onToggleStock: (next: boolean) => void;
  onRefresh: () => void;
  locale?: Locale;
  /** REEA-1114 — matches the In stock selection currently hides. */
  hiddenByStock?: number;
  /** REEA-1114 — matches the selected market hides. */
  hiddenByCountry?: number;
}) {
  const t = getStrings(locale ?? clientLocale());
  const countries: { code: CountryCode | null; label: string; aria: string }[] = [
    { code: null, label: t.filterAll, aria: t.filterAll },
    { code: "KW", label: t.countryKW, aria: t.countryKW },
    { code: "SA", label: t.filterSaudi, aria: t.countrySA },
    { code: "EG", label: t.countryEG, aria: t.countryEG },
  ];
  const inStockPressed = !showOutOfStock;
  const stockHidden = inStockPressed ? Math.max(0, hiddenByStock) : 0;

  return (
    <div className="rc-filter-bar" role="group" aria-label={t.filterAria}>
      {countries.map(({ code, label, aria }) => {
        const selected = code === country;
        const countryHidden = selected ? Math.max(0, hiddenByCountry) : 0;
        return (
          <button
            key={code ?? "all"}
            type="button"
            aria-pressed={selected}
            aria-label={
              countryHidden > 0
                ? `${aria}, ${fill(t.chipHiddenAria, { n: countryHidden })}`
                : aria
            }
            className="rc-chip"
            onClick={() => {
              rememberCountry(code);
              onSelectCountry(code);
            }}
          >
            {selected ? (
              <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m4 12.5 5 5L20 6.5" />
              </svg>
            ) : null}
            {label}
            {countryHidden > 0 ? <ChipHiddenCount count={countryHidden} locale={locale} /> : null}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={inStockPressed}
        aria-label={
          stockHidden > 0
            ? `${t.inStock}, ${fill(t.chipHiddenAria, { n: stockHidden })}`
            : undefined
        }
        className="rc-chip"
        onClick={() => {
          // Pressed means "show in-stock only" (hide out-of-stock). Toggling
          // the filter OFF reveals out-of-stock listings: the control is a
          // filter, not a checkbox on the listing set.
          const nextShowOutOfStock = inStockPressed;
          rememberShowOutOfStock(nextShowOutOfStock);
          onToggleStock(nextShowOutOfStock);
        }}
      >
        {inStockPressed ? (
          <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m4 12.5 5 5L20 6.5" />
          </svg>
        ) : null}
        {t.inStock}
        {stockHidden > 0 ? <ChipHiddenCount count={stockHidden} locale={locale} /> : null}
      </button>
      <button type="button" className="rc-chip is-action" onClick={onRefresh}>
        {t.refresh}
      </button>
    </div>
  );
}
