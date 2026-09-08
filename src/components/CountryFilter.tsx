"use client";

import Link from "next/link";
import {
  COUNTRY_OPTIONS,
  buildResultsHref,
  rememberCountry,
  type CountryCode,
} from "@/lib/country";

/**
 * REEA-170 — country pills on the results surface. Reuses the existing
 * query-pill pattern (Theme v1 chips) and the variation-selection emphasis
 * (§3.4: active = 2px primary ring) — no redesign. Each pill is a plain link
 * to the same query under `?c=`, so the selection rides in the URL and every
 * derived figure (prices, availability, alternatives) re-collects live under
 * it; "All" drops the param and behaves exactly as before. Clicking also
 * records the choice — one tap is enough: rememberCountry writes the same-tab
 * preference slot AND the single REEA-280 language-preference cookie
 * (`rc_market`) before navigation, so a returning visit starts on that
 * market (or on the explicit All choice) without re-selecting; the derived
 * Accept-Language default only applies while nothing has been chosen yet.
 * Country changes reset to page 1 — the filtered set is a different result
 * set.
 */
export default function CountryFilter({
  query,
  country,
}: {
  query: string;
  country: CountryCode | null;
}) {
  const items: { code: CountryCode | null; label: string }[] = [
    { code: null, label: "All" },
    ...COUNTRY_OPTIONS.map((o) => ({
      code: o.code as CountryCode,
      label: `${o.label} (${o.currency})`,
    })),
  ];
  return (
    <nav aria-label="Filter offers by country" className="flex flex-wrap items-center gap-2">
      {items.map(({ code, label }) => {
        const active = code === country;
        return (
          <Link
            key={code ?? "all"}
            href={buildResultsHref(query, 1, code)}
            onClick={() => rememberCountry(code)}
            aria-current={active ? "true" : undefined}
            className="query-pill query-pill-on-light focusable"
            style={active ? { boxShadow: "inset 0 0 0 2px var(--rc-primary)" } : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
