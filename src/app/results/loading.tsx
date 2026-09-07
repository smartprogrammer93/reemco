/**
 * REEA-114 — results loading state (Brief v4): slim amber pulse bar with a
 * live-collection label + 3 card ghosts. Shown while the query-time retailer
 * fan-out is in flight (server render and client navigations alike).
 */
function SkeletonCard() {
  return (
    <div className="result-card" aria-hidden>
      <div className="skeleton-block h-5 w-2/3" />
      <div className="skeleton-block mt-2 h-4 w-1/3" />
      <div className="skeleton-block mt-4 h-7 w-32" />
      <div className="skeleton-block mt-4 h-12" />
      <div className="skeleton-block mt-2 h-12" />
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
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
