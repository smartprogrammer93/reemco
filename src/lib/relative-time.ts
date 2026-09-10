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

/**
 * Design v3 §5.5 dot rule: green while < 10 min old, amber thereafter. Lives
 * here so components stay render-pure — the clock is read once, via this
 * helper's default argument. Missing/invalid timestamps count as old.
 */
export function isTenMinutesOld(iso: string | undefined, now: number = Date.now()): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return true;
  return now - t >= 10 * 60 * 1000;
}

/**
 * REEA-510 — absolute collection clock for labeled last-seen fallback rows:
 * "collected HH:MM" (UTC hour:minute). Snapshot rows age past the relative
 * ladder's useful range quickly, so a filled column states the moment the
 * offers were actually collected rather than an age; missing/invalid stamps
 * return null and the caller falls back to the regular relative age. Pure +
 * deterministic so SSR and hydration always agree (REEA-283 clock discipline).
 */
export function collectedClock(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
