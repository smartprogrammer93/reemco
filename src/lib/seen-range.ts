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
 * REEA-1167 — the fold is PRODUCT- and MARKET-scoped. Observations carry the
 * merge identity of the listing they were scraped from (REEA-1167 identity on
 * the last-seen slot), so an accessory, bundle or sibling SKU a merchant
 * returned for the query can never widen a device card's range. Rows are
 * restricted to the card's own market, so a Kuwait-market card never renders
 * an EGP/SAR figure and a cross-market card renders only its own market's
 * currency. One scoped observation is honest ("first seen"); 2+ observations
 * still need ≥3 distinct days; a range wider than 3× renders nothing rather
 * than an unbelievable span (the module already has the "render nothing"
 * precedent in MIN_SEEN_DAYS).
 *
 * Rules kept intact (REEA-540 AC2/AC3):
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
 *
 * Pre-REEA-1167 observations carry no identity (the store predates the field).
 * They are attributed at MERCHANT level (the pre-1167 behavior), then market-
 * scoped and bounded by the 3× cap, so the transitional window cannot serve a
 * mixed-currency or unbelievable range. They age out of the 14-day window as
 * identity-tagged rounds accumulate; from then on the fold is strictly per
 * product.
 */
import { effectivePriceKwd, formatCountryPrice, toKwdNumeric } from "@/lib/format";
import { marketScope, offerMarket } from "@/lib/market";
import type { CountryCode } from "@/lib/country";
import {
  listingIdentity,
  sameListingIdentity,
  storageFromListingUrl,
  type ListingIdentity,
} from "@/lib/collect/canonical-product";
import type { NormalizedProduct, SeenRange } from "@/types/product";

/** Rolling observation window for the confidence line. */
export const SEEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Distinct observation days required before the line may render. */
export const MIN_SEEN_DAYS = 3;
/** REEA-1167 — a scoped range wider than this multiple renders nothing. */
export const MAX_SEEN_SPREAD = 3;

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
  /**
   * REEA-1167 — the merge identity the listing was grouped under when it was
   * scraped. Absent on observations written before the field existed; those
   * fall back to merchant-level attribution.
   */
  identity?: ListingIdentity;
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
 * actually serve this card, to the card's product identity (when the
 * observation carries one) and to the card's market. `null` when nothing is
 * in scope, when fewer than 2 observations survive, when the surviving set
 * spans fewer than MIN_SEEN_DAYS distinct days, when the market is unknown,
 * or when the resulting spread exceeds MAX_SEEN_SPREAD.
 */
export function seenRangeForCard(
  rows: ReadonlyArray<SeenRow>,
  merchants: ReadonlySet<string>,
  opts: {
    country?: CountryCode | null;
    nowMs: number;
    /** REEA-1167 — the card's merge identity; observations of another product
     *  (accessory, bundle, sibling SKU) never count. */
    identity?: ListingIdentity | null;
    /** REEA-1167 — the card's market. `undefined` keeps the legacy
     *  merchant-only fold (tests / callers that predate the field); `null`
     *  means the market could not be resolved, so nothing renders rather than
     *  a mixed-currency range. */
    market?: CountryCode | null;
    /** REEA-1167 — plausibility band (KWD-space) for observations that carry
     *  no identity, derived from the card's own in-market offers. A pre-1167
     *  row outside the band belongs to another product (an accessory on a
     *  device card, a phone on a case card) and is dropped. */
    legacyBand?: { lo: number; hi: number } | null;
  },
): SeenRange | null {
  const country = opts.country ?? null;
  const market = opts.market;
  // A card whose market cannot be resolved has no single display currency:
  // render nothing rather than a mixed-currency range.
  if (market === null) return null;
  const identity = opts.identity ?? null;
  const band = opts.legacyBand ?? null;
  const kept = merchantDayWinners(rows, opts.nowMs).filter((r) => {
    if (!merchants.has(r.merchant)) return false;
    if (country && r.country && r.country !== country) return false;
    if (market !== undefined && offerMarket(r.currency) !== market) return false;
    if (identity) {
      if (r.identity) return sameListingIdentity(identity, r.identity);
      // Pre-identity rows: merchant-level attribution, bounded by the same
      // 3× plausibility the final range cap uses. An accessory's KD 3.50 can
      // no longer widen a KD 339 phone card, and a phone's KD 429.90 can no
      // longer land on a KD 15 case card.
      if (band) {
        const v = toKwdNumeric(r.price, r.currency);
        return Number.isFinite(v) && v >= band.lo && v <= band.hi;
      }
    }
    return true;
  });
  const priced = kept.filter((r) => Number.isFinite(toKwdNumeric(r.price, r.currency)));
  if (priced.length === 0) return null;
  // REEA-1167 addition — one scoped observation is honest: "first seen".
  if (priced.length === 1) {
    const only = priced[0];
    return {
      min: { price: only.price, currency: only.currency },
      max: { price: only.price, currency: only.currency },
      firstSeen: true,
    };
  }
  const days = new Set(priced.map((r) => r.day));
  if (days.size < MIN_SEEN_DAYS) return null;
  let min: SeenRow | null = null;
  let max: SeenRow | null = null;
  for (const r of priced) {
    const v = toKwdNumeric(r.price, r.currency);
    if (min == null || v < toKwdNumeric(min.price, min.currency)) min = r;
    if (max == null || v > toKwdNumeric(max.price, max.currency)) max = r;
  }
  if (!min || !max) return null;
  const lo = toKwdNumeric(min.price, min.currency);
  const hi = toKwdNumeric(max.price, max.currency);
  const spread = lo > 0 ? hi / lo : hi <= 0 ? 1 : Infinity;
  if (spread > MAX_SEEN_SPREAD) return null;
  return { min: { price: min.price, currency: min.currency }, max: { price: max.price, currency: max.currency } };
}

/**
 * REEA-1167 — the market a card is presented in: the selected scope when the
 * card has an offer there, else the market of its cheapest known-market offer
 * (a cross-market card's own market). Null when no offer's currency maps to a
 * market — the card then has no single display currency and renders nothing.
 */
function cardMarketOf(product: NormalizedProduct, scope: CountryCode): CountryCode | null {
  let cheapest: { market: CountryCode; key: number } | null = null;
  let hasScope = false;
  for (const offer of product.offers) {
    const market = offerMarket(offer.currency);
    if (market === null) continue;
    if (market === scope) hasScope = true;
    const key = effectivePriceKwd(offer.price, offer.currency, { wasPrice: offer.wasPrice });
    if (!cheapest || key < cheapest.key) cheapest = { market, key };
  }
  return hasScope ? scope : cheapest?.market ?? null;
}

/**
 * REEA-1167 — the plausibility band for pre-identity observations, in
 * KWD-space, from the card's own in-market offers. The same 3× bound the
 * range cap enforces: a legacy row outside it cannot be this product.
 */
function legacyBandFor(
  product: NormalizedProduct,
  market: CountryCode,
): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const offer of product.offers) {
    if (offerMarket(offer.currency) !== market) continue;
    const value = effectivePriceKwd(offer.price, offer.currency, { wasPrice: offer.wasPrice });
    if (!Number.isFinite(value) || value <= 0) continue;
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
  return { lo: lo / MAX_SEEN_SPREAD, hi: hi * MAX_SEEN_SPREAD };
}

/**
 * REEA-1167 — the merge identity of a SERVED card. The title carries the
 * canonical fields; a capacity the title omits is seeded from the card's own
 * listing URLs (the same REEA-1140 rule the grouping pass applies) only when
 * those URLs name ONE tier — a family card whose offers span several
 * capacities keeps a capacity-less identity so every tier's observations stay
 * in scope.
 */
function cardIdentityOf(product: NormalizedProduct): ListingIdentity {
  const base = listingIdentity(product.title);
  if (base.fields.storage) return base;
  const storages = new Set<string>();
  for (const offer of product.offers) {
    const storage = storageFromListingUrl(offer.url);
    if (storage) storages.add(storage);
  }
  if (storages.size !== 1) return base;
  const [storage] = storages;
  return { fields: { ...base.fields, storage }, accessory: base.accessory };
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
  // The surface's market scope: the explicit selection, else the home market
  // (REEA-1142). A card with no offer there falls back to its own market.
  const scope = marketScope(opts.country ?? null);
  for (const p of products) {
    const merchants = new Set(p.offers.map((o) => o.merchant));
    const market = cardMarketOf(p, scope);
    const range = seenRangeForCard(rows, merchants, {
      country: opts.country ?? null,
      nowMs,
      identity: cardIdentityOf(p),
      market,
      legacyBand: market === null ? null : legacyBandFor(p, market),
    });
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
