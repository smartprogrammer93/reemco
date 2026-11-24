"use client";

import { useEffect, useState } from "react";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import { nextTheme, rememberTheme, type Theme } from "@/lib/theme";

/**
 * REEA-1159 — the global header's light/dark control.
 *
 * Design judgement calls (recorded on the task, not blocking the designer):
 *   - icon-only sun/moon, placed with the existing 44px header controls
 *     (language, menu) between them, because a text label next to the language
 *     button overflowed the 375px brand row;
 *   - the accessible name is the STATE ("Dark mode" / "الوضع الداكن") plus
 *     `aria-pressed`, the standard toggle-button pair, so assistive tech
 *     announces pressed/not pressed instead of a label that flips under the
 *     user. The action hint rides `title`.
 *
 * Hydration contract: `initialTheme` is the SERVER's cookie read, passed down
 * by the layout. With a stored choice the first paint already carries
 * <html data-theme="…"> from the server, so nothing flips after hydration.
 * With no stored choice the attribute is absent and the shipped
 * `@media (prefers-color-scheme: dark)` rules follow the OS; the OS value is
 * read in an effect AFTER mount (never during render), so SSR and the first
 * hydration pass agree exactly and there is no React #418. No Date.now(),
 * Math.random() or locale-dependent formatting here.
 */
export default function ThemeToggle({
  locale,
  initialTheme,
}: {
  locale: Locale;
  initialTheme: Theme | null;
}) {
  const t = getStrings(locale);
  // The explicit choice from the server cookie; null = "follow the OS".
  const [chosen, setChosen] = useState<Theme | null>(initialTheme);
  // Resolved after mount only: during render it stays null on both sides.
  const [systemDark, setSystemDark] = useState<boolean | null>(null);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const sync = () => setSystemDark(mq.matches);
    sync();
    // Keep the announced state honest if the OS preference changes while the
    // shopper is on the page and has not stored an explicit choice.
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const isDark = chosen ? chosen === "dark" : systemDark === true;
  const actionHint = fill(t.themeToggleTo, {
    theme: isDark ? t.themeLight : t.themeDark,
  });

  const toggle = () => {
    const next = nextTheme(isDark ? "dark" : "light");
    setChosen(next);
    // The explicit choice overrides the OS from this click on: set the same
    // attribute the server writes from the cookie, so the whole page repaints
    // in one action (no reload), and persist it for the next page/reload.
    document.documentElement.dataset.theme = next;
    rememberTheme(next);
  };

  return (
    <button
      type="button"
      className="rc-icon-btn rc-theme-btn focusable"
      aria-label={t.themeLabel}
      aria-pressed={isDark}
      title={actionHint}
      onClick={toggle}
      data-theme-cookie="rc_theme"
    >
      {/* Sun = "currently dark, switch to light"; moon = the opposite. The
          glyph is decorative; the state lives in aria-pressed. */}
      {isDark ? (
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z" />
        </svg>
      )}
    </button>
  );
}
