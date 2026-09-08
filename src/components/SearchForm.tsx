"use client";

import { recallCountry, sanitizeCountry } from "@/lib/country";
import { recallShowOutOfStock, sanitizeShowOutOfStock } from "@/lib/stock";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/** Brief v4 search: hero 52px / compact 44px (AC6 tap floor) input + button.
 *  defaultValue echoes the active ?q so the query survives retry (AC5).
 *  REEA-279: chrome strings ride the static EN/AR table; the server-resolved
 *  locale comes down as a prop so first paint and hydration agree. */
export default function SearchForm({
  compact = false,
  defaultValue,
  country,
  oos,
  locale,
}: {
  compact?: boolean;
  defaultValue?: string;
  /** REEA-170 active country selection from the URL, if any. */
  country?: string | null;
  /** REEA-186 stock selection from the URL (`?oos=`), if any. */
  oos?: string | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const height = compact ? 44 : 52;
  // REEA-170: the selection rides every search through this hidden field —
  // URL param first, then the same-tab remembered choice — so a new search
  // keeps the filter without re-selecting (no cookies / localStorage).
  const carried = sanitizeCountry(country) ?? recallCountry();
  // REEA-186: same carry-over mechanism for the stock selection — checked
  // ships `oos=1`, unchecked submits the empty value (hide out-of-stock).
  const carriedOos = (sanitizeShowOutOfStock(oos) ?? recallShowOutOfStock()) ?? false;
  return (
    <form
      key={`${defaultValue ?? ""}|${carried ?? ""}|${carriedOos ? "1" : ""}`}
      action="/results"
      method="get"
      className="flex flex-wrap gap-2 sm:flex-nowrap"
      role="search"
      onSubmit={(e) => {
        // REEA-291 AC4 — the in-place selections (REEA-170 pills, REEA-186
        // toggle) echo the address with history.replaceState, which does NOT
        // re-render this header form. Read the LIVE location + the remembered
        // slots right at submit so the hidden carry-over fields ship the
        // shopper's current selections with the next query — the hand-off the
        // old link-navigation model got for free.
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
      {/* REEA-75: min-w-0 lets the input shrink below its intrinsic width;
          basis-full stacks it above the button under sm (375px-safe). */}
      <input
        type="search"
        name="q"
        placeholder={t.searchPlaceholder}
        aria-label={t.searchLabel}
        defaultValue={defaultValue}
        className="text-input focusable min-w-0 flex-1 basis-full px-4 sm:basis-auto"
        style={{ height }}
      />
      <button
        type="submit"
        className="btn-primary focusable w-full min-h-11 px-6 sm:w-auto"
        style={{ height }}
      >
        {t.searchButton}
      </button>
    </form>
  );
}
