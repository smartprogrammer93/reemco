/**
 * REEA-540 Bet A — the "Seen recently: <min>–<max> KD · last 14 days" line.
 *
 * Pure helpers that fold the LAST-SEEN observations a run already stored
 * (REEA-510 snapshots per merchant+query) into one confidence figure per
 * product card. Server-side only: `attachSeenRanges` runs when the snapshot
 * is built, so the served document carries the figure and the client never
 * fetches or recomputes anything (AC1). The roll-up reads STORED observations
 * — it never triggers a collection round itself.
 *
 * Rules (REEA-540 AC2/AC3):
 *  - window: only observations inside the rolling 14-day window count;
 *  - merchant-day dedup: one value per merchant-day — the latest observation
 *    of that day wins, earlier writes for the same merchant+day drop out;
 *  - ≥3 DISTINCT observation days are required over any offer of the card;
 *    below that the helper returns null and the card renders NOTHING — an
 *    under-populated range is never interpolated into one;
 *  - comparisons happen in KWD-space through the existing toKwdNumeric
 *    reference table (the same space the card's own cheapest-figure base
 *    uses), so a mixed-currency card keeps one scale; display figures ride
 *    through formatCountryPrice like every other price on the card.
 *    Best-price badge and cheapest-first sort are untouched by this module.
 */
import { formatCountryPrice, toKwdNumeric } from "@/lib/format";
import type { CountryCode } from "@/lib/country";
import type { NormalizedProduct, SeenRange } from "@/types/product";

/** Rolling observation window for the confidence line. */
export const SEEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Distinct observation days required before the line may render. */
export const MIN_SEEN_DAYS = 3;

/** One observed offer row, as flattened out of a last-seen snapshot. */
export interface SeenRow {
  merchant: string;
  /** Observation day as the ISO date part ("2026-09-10"). */
  day: string;
  /** ISO stamp of the round that recorded it (dedup tie-break). */
  observedAt: string;
  /** Observed native figure and the currency it was scraped in. */
  price: number;
  currency: string;
  country?: CountryCode;
}

/**
 * Merchant-day winners inside the rolling window: per merchant+day keep the
 * rows of the LATEST observation only (AC3). Rows of one winner share its
 * stamp, so they survive together. Pure and deterministic on `nowMs`.
 */
export function merchantDayWinners(rows: ReadonlyArray<SeenRow>, nowMs: number): SeenRow[] {
  const winners = new Map<string, SeenRow[]>();
  const stamps = new Map<string, number>();
  for (const row of rows) {
    const t = Date.parse(row.observedAt);
    if (Number.isNaN(t) || nowMs - t > SEEN_WINDOW_MS) continue;
    const key = `${row.merchant}\u0000${row.day}`;
    const cur = stamps.get(key);
    if (cur == null || t >= cur) {
      if (cur === t) winners.get(key)!.push(row);
      else {
        winners.set(key, [row]);
        stamps.set(key, t);
      }
    }
  }
  return [...winners.values()].flat();
}

/**
 * Range over the merchant-day winners, restricted to the merchants that
 * actually serve this card (observations are stored per merchant+query — the
 * same identity the card's offers carry) and, when a country selection is
 * active, to that selection's rows. `null` below MIN_SEEN_DAYS distinct days.
 */
export function seenRangeForCard(
  rows: ReadonlyArray<SeenRow>,
  merchants: ReadonlySet<string>,
  opts: { country?: CountryCode | null; nowMs: number },
): SeenRange | null {
  const country = opts.country ?? null;
  const kept = merchantDayWinners(rows, opts.nowMs).filter(
    (r) => merchants.has(r.merchant) && (!country || !r.country || r.country === country),
  );
  const days = new Set(kept.map((r) => r.day));
  if (days.size < MIN_SEEN_DAYS) return null;
  let min: SeenRow | null = null;
  let max: SeenRow | null = null;
  for (const r of kept) {
    const v = toKwdNumeric(r.price, r.currency);
    if (!Number.isFinite(v)) continue;
    if (min == null || v < toKwdNumeric(min.price, min.currency)) min = r;
    if (max == null || v > toKwdNumeric(max.price, max.currency)) max = r;
  }
  if (!min || !max) return null;
  return { min: { price: min.price, currency: min.currency }, max: { price: max.price, currency: max.currency } };
}

/** Attach the range to every card of one server-built snapshot. Best-effort:
 *  missing observations simply leave the cards as they are. */
export function attachSeenRanges(
  products: NormalizedProduct[],
  rows: ReadonlyArray<SeenRow>,
  opts: { country?: CountryCode | null; nowMs?: number } = {},
): void {
  if (rows.length === 0 || products.length === 0) return;
  const nowMs = opts.nowMs ?? Date.now();
  for (const p of products) {
    const merchants = new Set(p.offers.map((o) => o.merchant));
    const range = seenRangeForCard(rows, merchants, { country: opts.country ?? null, nowMs });
    if (range) p.seenRange = range;
  }
}

/** Range label through the EXISTING country-led formatter (AC4): each end
 *  renders like every other price on the card ("KD 4,099"); a one-value
 *  window collapses to the single figure. */
export function formatSeenRangeLabel(range: SeenRange, country: CountryCode | null): string {
  const lo = formatCountryPrice(range.min.price, range.min.currency, country).primary;
  if (range.max.price === range.min.price && range.max.currency === range.min.currency) return lo;
  const hi = formatCountryPrice(range.max.price, range.max.currency, country).primary;
  return `${lo}\u2013${hi}`;
}
