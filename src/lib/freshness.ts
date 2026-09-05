/**
 * Last-verified freshness buckets (REEA-65 §4.1).
 *
 * Source of truth is the existing per-record scrape metadata (`scraped_at` as
 * captured by the scraping pipeline; mapped to `NormalizedProduct.scrapedAt`).
 * No new data is collected — this only renders what the feed already carries.
 *
 * Buckets: <1h → "minutes ago"; <24h → hours; <7d → days; >7d → stale.
 * Missing or unparseable timestamps return null — callers render
 * "Verification date unknown" and never fabricate a date.
 */

export interface Freshness {
  /** Human-readable relative age, e.g. "3h ago" or "minutes ago". */
  label: string;
  /** True when the record is older than 7 days (may be outdated). */
  stale: boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const STALE_AFTER_DAYS = 7;

export function freshness(scrapedAt: string | undefined, now: number = Date.now()): Freshness | null {
  if (!scrapedAt) return null;
  const t = new Date(scrapedAt).getTime();
  if (Number.isNaN(t)) return null;

  const ageMs = now - t;
  // A future timestamp is bad metadata, not freshness — treat as unknown.
  if (ageMs < 0) return null;

  if (ageMs < HOUR) return { label: "minutes ago", stale: false };
  if (ageMs < DAY) return { label: `${Math.floor(ageMs / HOUR)}h ago`, stale: false };
  const days = Math.floor(ageMs / DAY);
  return { label: `${days}d ago`, stale: days > STALE_AFTER_DAYS };
}
