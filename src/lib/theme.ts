/**
 * REEA-1159 — shopper-facing light/dark theme preference.
 *
 * The site already ships a complete dark token map (globals.css `--rc-dark-*`,
 * consumed by `@media (prefers-color-scheme: dark)`), so this module is only
 * the PREFERENCE layer: one cookie (`rc_theme`), no new palette, no profile,
 * no fingerprint. It mirrors the REEA-279 locale preference contract:
 *
 *   - the explicit choice lives in ONE cookie and is read by the SERVER on the
 *     next request, so the first paint ships the right `data-theme` on <html>
 *     and there is no flash and no hydration mismatch (no inline script, so
 *     nothing extra to nonce under the REEA-1088 CSP path);
 *   - with no cookie the attribute is absent and the shipped
 *     `@media (prefers-color-scheme: dark)` rules keep following the OS,
 *     exactly as before this change;
 *   - the value is normalized, never trusted raw.
 *
 * This module stays importable by CLIENT components, so it carries no
 * `next/headers` import; the request-time read lives in theme-server.ts.
 */

/** The single theme-preference cookie. No other persistent storage. */
export const THEME_COOKIE = "rc_theme";

export type Theme = "light" | "dark";

/** A year: a deliberate theme choice outlives the session it was made in. */
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The cookie value is normalized, not trusted raw: only the two shipped themes
 * count. Anything else (missing, stale, tampered) degrades to "no choice", so
 * the OS preference keeps governing the page.
 */
export function normalizeThemeCookie(raw: unknown): Theme | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "light") return "light";
  if (v === "dark") return "dark";
  return null;
}

/** The explicit opposite — one action flips the theme, never a no-op. */
export function nextTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}

/** Client read (tests / static hosts). Server reads use theme-server.ts. */
export function readThemeCookie(): Theme | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=([^;]*)`));
  return normalizeThemeCookie(match?.[1]);
}

/**
 * Toggle write: the ONLY persistent storage the theme feature keeps. Same
 * attributes as the locale cookie (path=/ so it covers every page,
 * SameSite=Lax, year-long) so both preferences behave identically.
 */
export function rememberTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
  }
}

/** Test support: deterministic starting point across cases. */
export function resetThemePrefs(): void {
  if (typeof document !== "undefined") {
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0`;
  }
}
