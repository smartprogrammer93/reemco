/**
 * Relative-age helper for provenance lines (REEA-84 plan AC4: "collected Xs
 * ago"). Sub-minute precision matters during a live collection run, which the
 * v1 `freshness()` buckets (minutes/hours/days) do not provide.
 * Returns null for missing/invalid/future timestamps — callers render an
 * explicit "unknown" and never fabricate a time.
 */

export function relativeAge(
  iso: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ageMs = now - t;
  if (ageMs < 0) return null;
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
