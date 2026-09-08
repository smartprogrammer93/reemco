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

export default function ResultsLoading() {
  return (
    <div
      className="mx-auto w-full space-y-4 px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      <div className="pulse-bar" aria-hidden>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        Checking live stores…
      </p>
      {/* Heading slot at the h1's own display height (same clamp math as
          --rc-text-display × line-height 1.05) so the settled heading lands
          without pushing anything below it. */}
      <div className="skeleton-block" style={{ width: "45%", height: "clamp(36px, 4.8vw, 55px)" }} aria-hidden />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
