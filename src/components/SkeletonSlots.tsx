/**
 * REEA-756 — the loading geometry shared by every results-surface flash, so
 * the three sites (results/loading.tsx route flash, LoadingFallback streamed
 * shell, and the append blocks' reserved rows) stay byte-identical (REEA-224
 * identical-markup rule) and a chunk landing swaps INTO its slot instead of
 * pushing the rows below it down.
 *
 * REEA-756 makes the card ghosts NAMED per-retailer slots: each ghost row
 * carries its merchant's name on the real card's chip grammar (`.label-token`
 * — the same token the offer rows use), so the space a retailer's rows will
 * take is reserved under its own name while its hop is still in flight. The
 * names come from COVERAGE_ORDER — the fixed adapter presentation order that
 * the coverage sentence itself reads (coverage.ts), not a second registry —
 * and the count mirrors the first card's usual retailer row count. Names are
 * presentation slots, not offers: the offer data still rides the live
 * per-query fan-out. Keeping this module dependency-light matters: it lands
 * in the browser bundle through ResultsClient (same rule as coverage.ts).
 */
import { COVERAGE_ORDER } from "@/lib/collect/coverage";

/* Heading slot at the h1's own display height (same clamp math as
   --rc-text-display × line-height 1.05) so the settled heading lands
   without pushing anything below it. Shared by the initial fallback and
   the REEA-437 provisional-zero state. */
export function HeadingGhost() {
  return (
    <div className="skeleton-block" style={{ width: "45%", height: "clamp(36px, 4.8vw, 55px)" }} aria-hidden />
  );
}

/* REEA-693 item 1 — the coverage stamp (StageCoverage / CoverageLine) rides a
   LATE boundary: it lands after the staged card blocks have already painted.
   Unreserved, that late line pushes the whole visible grid down between
   flushes — the layout shift the acceptance line forbids. A one-line
   invisible stamp of the same .meta-stamp type reserves exactly its height,
   so the real sentence swaps into its own slot without moving anything. */
export function StampGhost() {
  return (
    <p className="meta-stamp" aria-hidden style={{ visibility: "hidden" }}>
      .
    </p>
  );
}

/* Card ghost on the REAL card geometry (.skeleton-card in globals.css keeps
   the min-height — same radius/padding/gutter, REEA-224 item 2) with the
   REEA-756 named per-retailer row slots: title line, price line, coupon
   pill line, then one named slot per leading retailer in COVERAGE_ORDER.
   When the retailer's chunk lands its offer row swaps into the named slot;
   nothing below the row moves — the CLS the acceptance line grades stays
   inside one row height. */
export function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden>
      <div className="skeleton-block w-2/3" />
      <div className="skeleton-block mt-2 w-1/3" />
      <div className="skeleton-block mt-4 w-32" />
      {COVERAGE_ORDER.slice(0, 4).map((merchant) => (
        <div key={merchant} className="mt-4 flex items-center gap-2">
          <span className="label-token rounded px-2 py-0.5" style={{ color: "var(--rc-muted)" }}>
            {merchant}
          </span>
          <div className="skeleton-block min-w-0 flex-1" />
        </div>
      ))}
    </div>
  );
}
