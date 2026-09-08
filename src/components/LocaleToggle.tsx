"use client";

import { LOCALE_COOKIE, getStrings, rememberLocale, type Locale } from "@/lib/i18n";

/**
 * REEA-279 — EN/AR chrome toggle. The button names the LANGUAGE IT SWITCHES
 * TO, written in that language's own script (عربي while English is shown,
 * English while Arabic is shown), so the affordance is findable from either
 * language. Clicking records the choice in the single rc_locale preference
 * cookie (rememberLocale — cookie only, no profiling beyond the preference)
 * and reloads the shell so the server re-renders every chrome string and the
 * html lang/dir attributes from the new cookie. Reloading is the smallest
 * mechanism that switches html lang too — document.documentElement alone
 * cannot re-attribute the already-rendered strings.
 */
export default function LocaleToggle({ locale }: { locale: Locale }) {
  const t = getStrings(locale);
  const next: Locale = locale === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      aria-label={t.toggleAria}
      onClick={() => {
        rememberLocale(next);
        // The cookie rides the next request; the server layout re-reads it
        // (resolveRequestLocale) and ships the mirrored shell. Guarded so
        // non-browser hosts (vitest jsdom without a location object still
        // records the cookie) stay deterministic.
        if (typeof window !== "undefined") window.location.reload();
      }}
      className="focusable shrink-0 rounded px-2 py-1 hover:underline"
      style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
      data-locale-cookie={LOCALE_COOKIE}
    >
      {t.toggleLabel}
    </button>
  );
}
