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

/**
 * REEA-930 scope 1 — whole-second age of a collection stamp, for the CTA
 * freshness line. Null for missing/invalid stamps (the same honesty rule as
 * relativeAge: callers fall back to the plain label, never fabricate a time).
 * A PARSEABLE stamp is a real collection moment, so the age floors at 0
 * (REEA-947 AC1): the CTA's baked reference clock (`renderStartMs`) is read
 * BEFORE the live fan-out kicks off, so offers collected inside the same
 * render carry stamps a few hundred ms AFTER it — a raw negative delta that
 * is a render-order artifact, not a bogus stamp. Clamping to 0 is the honest
 * "checked just now" (the exact Math.max(0,…) discipline FreshnessBadge
 * already applies to the same race); LiveAge re-ticks against the real clock
 * after hydration, where the delta is positive again. Deliberately
 * unformatted — the bucket copy lives in i18n.localizedAge so the CTA can
 * localize it; the clock stays injectable (baked renderStartMs on the
 * server, Date.now() only in the live ticker).
 */
export function ageSeconds(
  iso: string | undefined,
  now: number = Date.now(),
): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}

/**
 * REEA-759 — absolute collection stamp for the detail view, alongside the
 * relative age the offer rows already carry: "just now" scans fast, but only
 * an absolute moment answers "when, exactly, was this collected?". Format is
 * the designer-confirmed locale-invariant pair (REEA-759 design confirmation
 * §3): `YYYY-MM-DD HH:mm UTC`, minute precision, Latin digits, UTC — the same
 * string in EN and AR chrome, `<bdi>`-wrapped by the caller inside RTL flow.
 * Pure and deterministic (reads NO clock — only the stamp itself), so SSR and
 * hydration always agree (REEA-283 clock discipline). Null for missing or
 * invalid stamps — the same honesty rule as relativeAge: callers render
 * nothing rather than fabricate a moment.
 */
export function absoluteStamp(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${hh}:${mm} UTC`;
}
