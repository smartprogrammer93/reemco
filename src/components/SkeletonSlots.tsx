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
   the REEA-437 provisional-zero state. REEA-778 check 2: the class pair
   `heading-slot skeleton-block` is what the first streamed flush must
   carry, so the heading paints in-slot from the very first paint. */
export function HeadingGhost() {
  return (
    <div className="heading-slot skeleton-block" style={{ width: "45%", height: "clamp(36px, 4.8vw, 55px)" }} aria-hidden />
  );
}

/* REEA-778 lh-tier — the ONE deterministic coverage-line box for both
   streaming states. The settled coverage sentence wraps by locale: one
   line in EN, ~two in AR (the Arabic sentence is longer than the Latin
   one at the same width). A single shared reserve per locale tier — sized
   in lh (the .meta-stamp line-height unit already set by the font token)
   — keeps the reserve and the settled sentence in the SAME box, so the
   swap never changes height and the grid below never moves. Same helper
   on both sides of the boundary swap is the identical-markup rule (REEA-
   224) for this slot. */
export function coverageLhTier(locale?: string): number {
  return locale === "ar" ? 2 : 1;
}

/* REEA-693 item 1 — the coverage stamp (StageCoverage / CoverageLine) rides a
   LATE boundary: it lands after the staged card blocks have already painted.
   Unreserved, that late line pushes the whole visible grid down between
   flushes — the layout shift the acceptance line forbids. REEA-778: the
   reserve rides the SAME `meta-stamp coverage-line` grammar as the settled
   sentence, sized to the locale's lh tier (EN one line, AR two), so the
   real coverage line swaps into its own box and paints in-slot from the
   first streamed flush. */
export function StampGhost({ locale }: { locale?: string } = {}) {
  return (
    <p
      className="meta-stamp coverage-line"
      aria-hidden
      style={{ visibility: "hidden", minHeight: `${coverageLhTier(locale)}lh` }}
    >
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
