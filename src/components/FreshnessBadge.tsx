/**
 * Design v3 §5.5 freshness/provenance chip — never omitted: dot + age.
 * REEA-283: the chip carries a REAL minute figure in the served HTML — the
 * age is computed inside the server render from the request's render-start
 * timestamp (`renderStartMs`, serialized with the streamed payload) and the
 * hydration pass reuses that same value, so the digit never changes on
 * hydration (no Date.now() recompute, no mismatch). Green dot < 10 min, amber
 * thereafter ("staleness is honesty"). Stale (>7d, REEA-65 §4.1) keeps the
 * explicit "may be outdated" suffix. Missing metadata renders "updated date
 * unknown" — never a fabricated date.
 */
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";

export default function FreshnessBadge({
  scrapedAt,
  now,
  renderStartMs,
  locale,
}: {
  scrapedAt?: string;
  /** Injectable clock for deterministic tests; defaults to render time. */
  now?: number;
  /** REEA-283 server-render clock, serialized with the streamed props. */
  renderStartMs?: number;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const stampMs = scrapedAt ? Date.parse(scrapedAt) : NaN;
  if (!scrapedAt || Number.isNaN(stampMs)) {
    return (
      <span className="fresh-chip">
        <span className="fresh-dot is-late" aria-hidden />
        {t.freshUnknown}
      </span>
    );
  }
  // One clock reading for BOTH passes: the server bakes renderStartMs into the
  // payload and hydration reuses it; only surfaces without the prop (plain
  // catalog fallback) fall back to an injected/render-time clock.
  // eslint-disable-next-line react-hooks/purity -- fallback clock only when no baked renderStartMs/now prop is present (REEA-283).
  const nowMs = renderStartMs ?? now ?? Date.now();
  const mins = Math.max(0, Math.round((nowMs - stampMs) / 60000));
  const stale = mins >= 7 * 24 * 60;
  const late = mins >= 10;
  return (
    <span
      className="fresh-chip"
      title={stale ? t.staleTitle : undefined}
    >
      <span className={`fresh-dot${late ? " is-late" : ""}`} aria-hidden />
      {fill(t.freshUpdatedMinutes, { n: mins })}
      {stale ? t.staleSuffix : ""}
    </span>
  );
}
