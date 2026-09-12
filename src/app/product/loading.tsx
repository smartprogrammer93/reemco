/**
 * REEA-693 item 1 — /product shell flash. Detail visits run their live
 * identity resolution + job handshake while rendering; without a boundary
 * flash the whole page below the layout would wait on the slowest awaited
 * read. Same grammar as results/loading.tsx (Brief v4): slim amber pulse bar,
 * the live-collection stamp line, one heading slot and card ghosts that
 * reserve the real card geometry (.skeleton-card in globals.css) — the hero
 * card lands into its own slot, then the CollectionPanel streams its offers.
 * The manual Collect-now stays the no-JS fallback inside the panel itself.
 */
function SkeletonCard({ tall }: { tall?: boolean }) {
  return (
    <div className="skeleton-card" aria-hidden>
      <div className="skeleton-block w-2/3" />
      <div className="skeleton-block mt-2 w-1/3" />
      <div className="skeleton-block mt-4 w-32" />
      {tall ? <div className="skeleton-block mt-4 w-full" /> : null}
      <div className="skeleton-block mt-2 w-full" />
    </div>
  );
}

import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

export default async function ProductLoading() {
  // REEA-279 parity with the settled page: the flash stamp reads the same
  // locale chain (cookie → Accept-Language hint → "en"); when request-time
  // reads are unavailable it falls back silently, never crashes the shell.
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return (
    <div
      className="mx-auto w-full space-y-4 px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      {/* REEA-447 R1 — busy state mirrors the results flash: aria-busy rides
          while collecting, removed with the container on the settled swap. */}
      <div className="pulse-bar" aria-hidden aria-busy>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        {t.checkingStores}
      </p>
      {/* Heading slot at the detail hero's title height, then the hero card
          ghost and one offer-row ghost so the panel area keeps its position
          while the first streamed offer boundary lands. */}
      <div className="skeleton-block" style={{ width: "45%", height: "clamp(36px, 4.8vw, 55px)" }} aria-hidden />
      <SkeletonCard tall />
      <SkeletonCard />
    </div>
  );
}
