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
import { sanitizeSearchQuery } from "./search-params";

/**
 * REEA-447 R2 — the segment query text the locale chain is missing on a cold
 * document GET. Two request-time sources, in order:
 * 1. `next-url` — the full path+query Next's own router sends on its
 *    navigation renders (same read results/loading.tsx already relies on);
 * 2. `x-query-text` — forwarded by src/proxy.ts from the request URL's `q`
 *    param on every first GET, percent-encoded so the header stays
 *    ASCII-clean across the edge hop (decodeURIComponent'd back here).
 * Anything unreadable degrades to "no hint", exactly like the loading
 * partial's silent fallback — the chain then lands on cookie → Accept-Language
 * → "en" as before, never a crash.
 */
async function readRequestQueryText(headersList: Headers): Promise<string | undefined> {
  try {
    const nextUrl = headersList.get("next-url");
    if (nextUrl) {
      const raw = new URL(nextUrl, "http://localhost").searchParams.get("q");
      return sanitizeSearchQuery(raw) ?? undefined;
    }
    const encoded = headersList.get("x-query-text");
    if (!encoded) return undefined;
    let decoded = encoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      // Not percent-encoded (plain host) — use it as-is.
    }
    return sanitizeSearchQuery(decoded) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Server-side read behind the layout and pages: the request's cookie wins,
 * then the coarse Accept-Language header, then (REEA-448 G2) an Arabic-script
 * query text — the caller's explicit text when passed, otherwise the segment
 * query forwarded by the request itself (REEA-447 R2: html lang/dir follow the
 * query script, so "كيفيات" ships lang="ar" dir="rtl" even with no cookie and
 * no Accept-Language header), then "en". Home has no query to forward.
 */
export async function resolveRequestLocale(queryText?: string): Promise<"en" | "ar"> {
  try {
    const cookieStore = await cookies();
    const headersList = await headers();
    const hint = queryText ?? (await readRequestQueryText(headersList));
    return resolveUiLocale(
      cookieStore.get(LOCALE_COOKIE)?.value,
      headersList.get("accept-language"),
      hint,
    );
  } catch {
    return resolveUiLocale(undefined, null, queryText);
  }
}
