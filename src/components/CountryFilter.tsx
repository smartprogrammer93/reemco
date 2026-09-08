"use client";

import { COUNTRY_OPTIONS, rememberCountry, type CountryCode } from "@/lib/country";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/* Country-name keys in the static table, keyed by the adapter's country tag. */
const NAME_KEYS = { KW: "countryKW", SA: "countrySA", EG: "countryEG" } as const;

/**
 * REEA-170 — country pills on the results surface. Reuses the existing
 * query-pill pattern (Theme v1 chips) and the variation-selection emphasis
 * (§3.4: active = 2px primary ring) — no redesign.
 *
 * REEA-291 AC4 — the pills are IN-PLACE controls: clicking one filters the
 * already-loaded offer payload on the client (ResultsClient holds the full
 * live set and re-renders the filtered view). No navigation, no second
 * network round-trip — the live re-collection happens only behind the
 * explicit Refresh action. The click still records the choice the same way
 * the old link did: rememberCountry writes the same-tab preference slot AND
 * the single REEA-280 language-preference cookie (`rc_market`), so a
 * returning visit starts on that market (or on the explicit All choice)
 * without re-selecting; the derived Accept-Language default only applies
 * while nothing has been chosen yet. Selection changes reset to page 1 —
 * the filtered set is a different result set.
 */
export default function CountryFilter({
  country,
  onSelect,
  locale,
}: {
  country: CountryCode | null;
  /** Applied to the loaded payload immediately (AC4). */
  onSelect: (code: CountryCode | null) => void;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const items: { code: CountryCode | null; label: string }[] = [
    { code: null, label: t.filterAll },
    ...COUNTRY_OPTIONS.map((o) => ({
      code: o.code as CountryCode,
      label: `${t[NAME_KEYS[o.code]]} (${o.currency})`,
    })),
  ];
  return (
    <nav aria-label={t.filterCountryAria} className="flex flex-wrap items-center gap-2">
      {items.map(({ code, label }) => {
        const active = code === country;
        return (
          <button
            key={code ?? "all"}
            type="button"
            onClick={() => {
              rememberCountry(code);
              onSelect(code);
            }}
            aria-current={active ? "true" : undefined}
            className="query-pill query-pill-on-light focusable"
            style={active ? { boxShadow: "inset 0 0 0 2px var(--rc-primary)" } : undefined}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
