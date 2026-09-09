/**
 * REEA-279 (server half) — the request-time locale read behind the layout.
 *
 * `cookies`/`headers` are request-time APIs available in Server Components
 * only, so they live HERE — a module imported exclusively by the server
 * graph. The shared chrome module (src/lib/i18n.ts) stays free of
 * `next/headers` so Client Components can bundle it, and the resolution
 * CHAIN itself (cookie → coarse Accept-Language hint → "en") stays one pure
 * function shared by both halves: resolveUiLocale.
 *
 * On a prerendered/static host the request-time reads fall back silently to
 * the hint/default instead of failing the shell render (same guard as
 * readPreferenceHint on the results page).
 */
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveUiLocale } from "./i18n";

/**
 * Server-side read behind the layout and pages: the request's cookie wins,
 * then the coarse Accept-Language header, then (REEA-448 G2) an Arabic-script
 * query text when the caller passes one, then "en". Home passes no query
 * text — the surface has none.
 */
export async function resolveRequestLocale(queryText?: string): Promise<"en" | "ar"> {
  try {
    const cookieStore = await cookies();
    const headersList = await headers();
    return resolveUiLocale(
      cookieStore.get(LOCALE_COOKIE)?.value,
      headersList.get("accept-language"),
      queryText,
    );
  } catch {
    return resolveUiLocale(undefined, null, queryText);
  }
}
