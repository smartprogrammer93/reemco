/**
 * REEA-1159 (server half) — the request-time theme read behind the layout.
 *
 * `cookies` is a request-time API available in Server Components only, so it
 * lives HERE — a module imported exclusively by the server graph. The shared
 * preference module (src/lib/theme.ts) stays free of `next/headers` so Client
 * Components can bundle it.
 *
 * The layout writes the returned value into <html data-theme="…">. Returning
 * null means "no explicit choice": the attribute is omitted and the shipped
 * `@media (prefers-color-scheme: dark)` rules follow the OS preference, which
 * is the pre-REEA-1159 behaviour. That is why this is a SERVER read rather
 * than an inline bootstrap script: the first paint is already correct, with no
 * flash of the wrong theme and no client/server disagreement to hydrate
 * against. It also keeps the REEA-1088 CSP path untouched — no new inline
 * script needs a nonce.
 *
 * On a prerendered/static host the read falls back to null instead of failing
 * the shell render (same guard as resolveRequestLocale).
 */
import { cookies } from "next/headers";
import { THEME_COOKIE, normalizeThemeCookie, type Theme } from "./theme";

export async function resolveRequestTheme(): Promise<Theme | null> {
  try {
    const cookieStore = await cookies();
    return normalizeThemeCookie(cookieStore.get(THEME_COOKIE)?.value);
  } catch {
    return null;
  }
}
