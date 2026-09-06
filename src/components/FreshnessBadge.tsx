import { freshness } from "@/lib/freshness";
import { isTenMinutesOld } from "@/lib/relative-time";

/**
 * Design v3 §5.5 freshness/provenance chip — never omitted: dot + relative
 * time. Green dot < 10 min, amber thereafter ("staleness is honesty"). Stale
 * (>7d, REEA-65 §4.1) keeps the explicit "may be outdated" suffix. Missing
 * metadata renders "updated date unknown" — never a fabricated date.
 */
export default function FreshnessBadge({
  scrapedAt,
  now,
}: {
  scrapedAt?: string;
  /** Injectable clock for deterministic tests; defaults to render time. */
  now?: number;
}) {
  const f = freshness(scrapedAt, now);
  if (!f) {
    return (
      <span className="fresh-chip">
        <span className="fresh-dot is-late" aria-hidden />
        updated date unknown
      </span>
    );
  }
  const late = isTenMinutesOld(scrapedAt, now);
  return (
    <span
      className="fresh-chip"
      title={
        f.stale ? "Last verified more than 7 days ago — the price may be outdated." : undefined
      }
    >
      <span className={`fresh-dot${late ? " is-late" : ""}`} aria-hidden />
      updated {f.label}
      {f.stale ? " · may be outdated" : ""}
    </span>
  );
}
