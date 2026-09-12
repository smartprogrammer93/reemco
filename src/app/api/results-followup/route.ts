/**
 * REEA-398 — follow-up feed for the completion-budget results page.
 *
 * The streamed page finalizes on the completion budget (~2.8 s since REEA-693
 * item 1, ~1.8 s since REEA-756): whatever
 * answered by then is on screen with its honest coverage line, and the stream
 * closes. Hops still in flight keep running behind the finalized response (the
 * page schedules the run's `allSettled` through Next's `after()`); this route
 * hands the converged live snapshot to the open page so late offers fold in
 * in place — no reload, no bundled data:
 *  - same-worker fast path: the page registered its own run in the follow-up
 *    registry, so the feed awaits THAT run's converged chain directly — one
 *    live fan-out served the finalized document, the merge and the cache;
 *  - cross-worker path: `next start` hands requests to worker threads (43 of
 *    them measured locally), so a follow-up can land on a thread that never
 *    saw the page's registry. There the feed runs its own bounded live
 *    collection for the same query and waits for it to converge. Every hop is
 *    re-contacted live — never a bundled snapshot; the retailers that answer
 *    inside the wait window are exactly the ones the shopper is still
 *    missing, and past the REEA-291 fresh window the memo never serves stale
 *    instead of live.
 *
 * Contract: GET /api/results-followup?q=<query> answers
 *  - the converged LiveSearchResult JSON once every hop of the run has landed
 *    (bounded wait below), or
 *  - `null` when nothing useful converged in time — the page simply keeps
 *    what it rendered. Adapter status itself stays on the per-query coverage
 *    line (REEA-290); this feed only moves the late offers themselves.
 */
import type { LiveSearchResult } from "@/lib/collect/live-search";
import { collectLiveResultsStaged, followUpSnapshot } from "@/lib/collect/live-search";
import { sanitizeSearchQuery } from "@/lib/search-params";
import { LOCALE_COOKIE, resolveUiLocale } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A converged run is bounded by LIVE_SEARCH_BUDGET_MS at the latest; the wait
// below is what this handler spends before answering, the segment ceiling
// keeps the whole request inside one short window.
export const maxDuration = 20;

/** Bounded wait for the pending run to converge. */
const FOLLOW_UP_WAIT_MS = 8_000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = sanitizeSearchQuery(url.searchParams.get("q")) ?? "";
  // REEA-468 G5 — same resolution chain as the page (rc_locale cookie → coarse
  // Accept-Language → Arabic-script query), so the feed's snapshot selects the
  // representative titles for the SAME locale the shopper is looking at.
  const localeCookie = (req.headers.get("cookie") ?? "").match(
    new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`),
  )?.[1];
  const locale = resolveUiLocale(localeCookie, req.headers.get("accept-language"), query);

  // Same-worker fast path: the page's own run is still pending on this
  // thread — await its converged chain, no extra hop traffic at all.
  let pending = query ? followUpSnapshot(query, locale) : null;
  let fallbackFinal: Promise<LiveSearchResult> | null = null;
  if (!pending && query) {
    // Cross-worker path: re-collect live for this query on THIS thread.
    // Inside the REEA-291 fresh window the memo serves the last live answer
    // immediately; past it the fan-out runs again — always live-at-query-time.
    const staged = collectLiveResultsStaged(query, { locale });
    fallbackFinal = staged.final;
    pending = followUpSnapshot(query, locale);
  }

  const waited = pending ?? fallbackFinal;
  if (!waited) return Response.json(null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    waited.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FOLLOW_UP_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return Response.json(settled ?? null);
}
