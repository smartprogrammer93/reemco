"use client";

import { LOCALE_COOKIE, fill, getStrings, rememberLocale, type Locale } from "@/lib/i18n";

/**
 * REEA-279 / REEA-1069 — the global header's labelled language switch
 * (REEA-1055 AC2): a 44x44 control that names the language it switches TO in
 * that language's own script, with a globe glyph and an explicit aria-label.
 * Clicking records the choice in the single rc_locale preference cookie and
 * reloads the shell so the server re-renders every chrome string and the html
 * lang/dir attributes from the new cookie.
 */
export default function LocaleToggle({ locale }: { locale: Locale }) {
  const t = getStrings(locale);
  const next: Locale = locale === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      aria-label={fill(t.toggleAriaTo, { lang: t.toggleLabel })}
      onClick={() => {
        rememberLocale(next);
        if (typeof window !== "undefined") window.location.reload();
      }}
      className="rc-lang-btn focusable"
      data-locale-cookie={LOCALE_COOKIE}
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
      </svg>
      <span>{t.toggleLabel}</span>
    </button>
  );
}
