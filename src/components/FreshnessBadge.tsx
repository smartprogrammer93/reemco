import { freshness } from "@/lib/freshness";

/**
 * REEA-65 §4.1 — last-verified freshness on result cards and detail.
 * Fresh: neutral "Verified <X ago>". Stale (>7d): amber "… may be outdated"
 * (honesty signal, must-have per the spec's Kano note). Missing metadata
 * renders "Verification date unknown" — never a fabricated date.
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
      <span
        className="label-token inline-flex items-center rounded px-2 py-0.5"
        style={{
          color: "var(--color-ink-secondary)",
          background: "var(--color-surface-muted)",
          border: "1px solid var(--color-border)",
        }}
      >
        Verification date unknown
      </span>
    );
  }
  const text = `Verified ${f.label}`;
  return (
    <span
      className="label-token inline-flex items-center rounded px-2 py-0.5"
      title={f.stale ? "Last verified more than 7 days ago — the price may be outdated." : undefined}
      style={
        f.stale
          ? {
              color: "var(--color-warn-text)",
              border: "1px solid var(--color-warn)",
            }
          : {
              color: "var(--color-ink-secondary)",
              background: "var(--color-surface-muted)",
              border: "1px solid var(--color-border)",
            }
      }
    >
      {text}
      {f.stale ? " · may be outdated" : ""}
    </span>
  );
}
