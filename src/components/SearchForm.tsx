"use client";

import { recallCountry, sanitizeCountry } from "@/lib/country";
import { recallShowOutOfStock, sanitizeShowOutOfStock } from "@/lib/stock";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/** Direction A search: header 44px input + button inside a two-row 375
 *  header (input ≥200px), hero 52px, inline 44px. defaultValue echoes the
 *  active ?q so the query survives retry (AC5). REEA-279: chrome strings ride
 *  the static EN/AR table; the server-resolved locale comes down as a prop so
 *  first paint and hydration agree. */
export default function SearchForm({
  variant = "inline",
  defaultValue,
  country,
  oos,
  locale,
}: {
  variant?: "header" | "hero" | "inline";
  defaultValue?: string;
  /** REEA-170 active country selection from the URL, if any. */
  country?: string | null;
  /** REEA-186 stock selection from the URL (`?oos=`), if any. */
  oos?: string | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const header = variant === "header";
  const hero = variant === "hero";
  const height = hero ? 52 : 44;
  // REEA-170: the selection rides every search through this hidden field —
  // URL param first, then the same-tab remembered choice — so a new search
  // keeps the filter without re-selecting (no cookies / localStorage).
  const carried = sanitizeCountry(country) ?? recallCountry();
  // REEA-186: same carry-over mechanism for the stock selection — checked
  // ships `oos=1`, unchecked submits the empty value (hide out-of-stock).
  const carriedOos = (sanitizeShowOutOfStock(oos) ?? recallShowOutOfStock()) ?? false;
  const formClass = header
    ? "rc-header-search"
    : hero
      ? "rc-hero-search"
      : "flex flex-wrap gap-2 sm:flex-nowrap";
  return (
    <form
      key={`${defaultValue ?? ""}|${carried ?? ""}|${carriedOos ? "1" : ""}`}
      action="/results"
      method="get"
      className={formClass}
      role="search"
      onSubmit={(e) => {
        // REEA-291 AC4 — read the LIVE location + the remembered slots right
        // at submit so the hidden carry-over fields ship the shopper's current
        // selections with the next query.
        const form = e.currentTarget;
        const live = new URLSearchParams(window.location.search);
        const liveCountry = sanitizeCountry(live.get("c")) ?? recallCountry();
        const liveOos = sanitizeShowOutOfStock(live.get("oos")) ?? recallShowOutOfStock() ?? false;
        const cField = form.elements.namedItem("c") as HTMLInputElement | null;
        const oosField = form.elements.namedItem("oos") as HTMLInputElement | null;
        if (cField) cField.value = liveCountry ?? "";
        if (oosField) oosField.value = liveOos ? "1" : "";
      }}
    >
      <input type="hidden" name="c" defaultValue={carried ?? ""} />
      <input type="hidden" name="oos" defaultValue={carriedOos ? "1" : ""} />
      <div className="rc-search-field">
        <label className="sr-only" htmlFor={header ? "header-q" : hero ? "hero-q" : "inline-q"}>
          {t.searchLabel}
        </label>
        <input
          id={header ? "header-q" : hero ? "hero-q" : "inline-q"}
          type="search"
          name="q"
          placeholder={t.searchPlaceholder}
          aria-label={t.searchLabel}
          defaultValue={defaultValue}
          autoComplete="off"
          className="focusable"
          style={{ height }}
        />
        <svg className="icon-search" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" />
        </svg>
      </div>
      <button type="submit" className="btn-primary focusable shrink-0 px-6" style={{ height }}>
        {t.searchButton}
      </button>
    </form>
  );
}
