/**
 * REEA-114 — results loading state (Brief v4): slim amber pulse bar with a
 * live-collection label + 3 card ghosts. Shown while the query-time retailer
 * fan-out is in flight (server render and client navigations alike).
 *
 * REEA-224 item 2: the ghosts reserve the REAL card geometry (radius, card
 * padding, gutter — see .skeleton-card in globals.css) and a heading slot for
 * the `N results for …` h1 rides between the stamp line and the cards, so the
 * footer keeps its vertical position from first paint to settled grid. The
 * whole block is removed on first paint by the Suspense boundary; the real
 * h1 itself ships in the first streamed flush (ResultsClient.StageAppend).
 */
function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden>
      <div className="skeleton-block w-2/3" />
      <div className="skeleton-block mt-2 w-1/3" />
      <div className="skeleton-block mt-4 w-32" />
      <div className="skeleton-block mt-4 w-full" />
      <div className="skeleton-block mt-2 w-full" />
    </div>
  );
}

import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

export default async function ResultsLoading() {
  // REEA-279 — the loading stamp is chrome: it comes from the table too.
  // REEA-448 G2 / REEA-447 R2 — same chain as the settled page and layout:
  // resolveRequestLocale folds in the segment query text itself (Next's own
  // `next-url` header on navigation renders, else the query forwarded by
  // src/proxy.ts on the initial GET), so an Arabic-script query decides the
  // flash locale and the loading chrome never flashes English under an
  // Arabic title — and when request-time reads are unavailable the chain
  // falls back silently, exactly like the shell.
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return (
    <div
      className="mx-auto w-full space-y-4 px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      {/* REEA-447 R1 — busy state mirrors LoadingFallback exactly (REEA-224
          identical-markup rule): aria-busy rides the collecting rail and is
          gone with the container when the settled content swaps in. */}
      <div className="pulse-bar" aria-hidden aria-busy>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        {t.checkingStores}
      </p>
      {/* Heading slot at the h1's own display height (same clamp math as
          --rc-text-display × line-height 1.05) so the settled heading lands
          without pushing anything below it. */}
      <div className="skeleton-block" style={{ width: "45%", height: "clamp(36px, 4.8vw, 55px)" }} aria-hidden />
      {/* REEA-693 item 1 — one-line slot for the late coverage stamp (same
          .meta-stamp type as ResultsClient.StampGhost), so the settled stamp
          swaps into its own height instead of shifting the card block down. */}
      <p className="meta-stamp" aria-hidden style={{ visibility: "hidden" }}>.</p>
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
