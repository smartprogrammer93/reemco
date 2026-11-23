"use client";

import { rememberCountry, type CountryCode } from "@/lib/country";
import { rememberShowOutOfStock } from "@/lib/stock";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

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
 */
export default function FilterBar({
  country,
  showOutOfStock,
  onSelectCountry,
  onToggleStock,
  onRefresh,
  locale,
}: {
  country: CountryCode | null;
  showOutOfStock: boolean;
  onSelectCountry: (code: CountryCode | null) => void;
  onToggleStock: (next: boolean) => void;
  onRefresh: () => void;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const countries: { code: CountryCode | null; label: string; aria: string }[] = [
    { code: null, label: t.filterAll, aria: t.filterAll },
    { code: "KW", label: t.countryKW, aria: t.countryKW },
    { code: "SA", label: t.filterSaudi, aria: t.countrySA },
    { code: "EG", label: t.countryEG, aria: t.countryEG },
  ];
  const inStockPressed = !showOutOfStock;

  return (
    <div className="rc-filter-bar" role="group" aria-label={t.filterAria}>
      {countries.map(({ code, label, aria }) => {
        const selected = code === country;
        return (
          <button
            key={code ?? "all"}
            type="button"
            aria-pressed={selected}
            aria-label={aria}
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
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={inStockPressed}
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
      </button>
      <button type="button" className="rc-chip is-action" onClick={onRefresh}>
        {t.refresh}
      </button>
    </div>
  );
}
