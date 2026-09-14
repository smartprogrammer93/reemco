/**
 * REEA-963 R1 — query-time price sanity over the render cohort.
 *
 * Spec: REEA-961 §document-spec-r1-price-sanity (R1, P0). Every rule here
 * runs AT QUERY TIME on offers the adapters fetched live during that query —
 * no bundled/static price catalog exists anywhere in this module (company
 * data policy, spec §9): the median, the bounds and every flag derive only
 * from the hit set handed in by the caller for THIS render.
 *
 * What the pass produces:
 *  - a per-offer sanity annotation (status/reason/ratioToMedian) attached to
 *    every served offer row;
 *  - the exclusion inputs for rollups ("from KD X"), cheapest-highlighting
 *    and best-price claims (flagged offers stay visible, spec FR-1.3/1.4);
 *  - the freshest-wins (retailer, SKU) dedupe verdict for E5;
 *  - the per-render summary log (AC-7): query id, per-adapter offer counts,
 *    flagged counts by reason, and whether the outlier check was skipped for
 *    a tiny cohort.
 *
 * Outlier bound (FR-1.1/1.2): ratioToMedian > bound or < 1/bound flags.
 * The bound is CONFIGURATION, not a constant — PRICE_SANITY_OUTLIER_RATIO,
 * default 15 — so the config path flips previously-ok offers without a code
 * change (AC-6). The boundary is inclusive-by-exclusion: exactly 15.0× does
 * NOT flag (spec E6). Cohorts with fewer than SANITY_MIN_COHORT priceable
 * offers skip the check and say so in the log (FR-1.5, spec E1) — the median
 * of a tiny cohort is noise, and the bound is relative, never absolute KD,
 * so a legitimately cheap cohort ("phone case") stays sane (spec E7).
 */

import type { CountryCode } from "@/lib/country";
import { countryForCurrency } from "@/lib/country";
import { toKwdFactor } from "@/lib/format";
import type { OfferSanity, SanityReason } from "@/types/product";
import { normalizedListingUrlOf } from "@/lib/collect/types";

/** FR-1.5 — cohorts smaller than this skip the outlier check (median noise). */
export const SANITY_MIN_COHORT = 5;

/**
 * FR-1.2 — the outlier bound, one config value. PRICE_SANITY_OUTLIER_RATIO
 * (default 15) sets BOTH sides: flag when ratio > bound or < 1/bound. A
 * value that does not parse, is NaN, or is ≤ 1 (which would flag the median
 * itself) falls back to the documented default — the env knob can loosen or
 * tighten the bound, never break the pass.
 */
export const DEFAULT_OUTLIER_RATIO = 15;

export function sanityOutlierRatio(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PRICE_SANITY_OUTLIER_RATIO;
  if (!raw) return DEFAULT_OUTLIER_RATIO;
  const v = Number(raw);
  return Number.isFinite(v) && v > 1 ? v : DEFAULT_OUTLIER_RATIO;
}

export interface SanityInputHit {
  merchant: string;
  price: number;
  currency: string;
  url: string;
  collectedAt?: string;
}

/**
 * E4/AC-5 detection signal — the KWD-space value of an offer, or null when
 * the offer carries NO usable price (E3: 0/null/non-finite) or its currency
 * conversion FAILED (code missing from the reference table, spec E4) — such
 * an offer can never sit in a rollup as a comparable figure.
 */
export function kwdSanityValue(price: number, currency: string): number | null {
  if (!Number.isFinite(price) || price <= 0) return null; // E3
  const rate = toKwdFactor(currency);
  return rate == null ? null : price * rate;
}

/**
 * AC-5 — currency mis-map detection from LIVE evidence only: the offer's own
 * URL host vs its declared currency. A storefront's TLD names its market
 * (amazon.eg → .eg → EGP); when BOTH the host and the currency derive a
 * served-market country and the two disagree, the adapter's currency label
 * is a mis-map (the production case: EGP values labeled KWD on an .eg host).
 * Hosts that derive nothing (.com et al.) never flag — an honest cross-border
 * listing (jarir.com selling SAR, danube.sa stamped SAR on a KW-scoped
 * collector) stays untouched.
 */
export function currencyMisMap(url: string, currency: string): boolean {
  const currencyCountry = countryForCurrency(currency.trim().toUpperCase());
  const hostCountry = countryFromHost(url);
  if (!currencyCountry || !hostCountry) return false;
  return currencyCountry !== hostCountry;
}

/** Host TLD → served-market country, for the mis-map cross-check above. */
function countryFromHost(url: string): CountryCode | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".kw")) return "KW";
    if (host.endsWith(".sa")) return "SA";
    if (host.endsWith(".eg")) return "EG";
  } catch {
    /* unparseable URL — no evidence, no flag */
  }
  return null;
}

/** Median of a non-empty numeric array (average of the two middle values). */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** AC-7 summary — logged once per render (per cohort evaluation). */
export interface SanitySummary {
  queryId: string;
  /** Offers in the render cohort after (retailer, SKU) dedupe. */
  cohortOffers: number;
  /** Offers with a usable price whose currency conversion succeeded. */
  priceableOffers: number;
  /** Cohort median in KWD space; null when nothing was priceable. */
  medianKwd: number | null;
  /** FR-1.5 — true when the outlier check was skipped (cohort < 5). */
  outlierCheckSkipped: boolean;
  /** Flagged count per reason (only reasons that fired carry a count > 0). */
  flaggedByReason: Partial<Record<SanityReason, number>>;
  /** Per-adapter (merchant) offer and flag counts, AC-7. */
  perAdapter: Record<string, { offers: number; flagged: number }>;
  /** E5 — same (retailer, SKU) fetched twice with different prices; fresher won. */
  priceDivergences: number;
  /** FR-3.2 — unclassified offers inside a variant-bearing cohort (filled by the caller). */
  unclassifiedVariant: number;
}

export interface CohortSanity<H extends SanityInputHit> {
  /** Per-offer verdict, keyed by the exact hit object the caller passed in. */
  byOffer: Map<H, OfferSanity>;
  summary: SanitySummary;
  /** E5/FR-2.3 — the deduped cohort: one offer per (merchant, normalized
   *  listing URL), freshest collectedAt wins; ties keep the earlier entry
   *  (the REEA-908 cheapest-sorted survivor). */
  deduped: H[];
}

/**
 * The one cohort pass (spec §4/§5). `byOffer` flags EVERY offer of the
 * cohort — flagged offers stay visible; rollups and best-price claims read
 * `status !== "flagged"` (FR-1.4). The summary is returned, not logged here,
 * so the caller logs once per render after the derived rollups are counted.
 */
export function computeCohortSanity<H extends SanityInputHit>(
  queryId: string,
  hits: readonly H[],
  opts: { ratio?: number } = {},
): CohortSanity<H> {
  const ratioBound = opts.ratio ?? sanityOutlierRatio();
  const summary: SanitySummary = {
    queryId,
    cohortOffers: 0,
    priceableOffers: 0,
    medianKwd: null,
    outlierCheckSkipped: false,
    flaggedByReason: {},
    perAdapter: {},
    priceDivergences: 0,
    unclassifiedVariant: 0,
  };

  // FR-2.3/E5 — dedupe the cohort to one offer per (retailer, SKU) BEFORE any
  // comparison reads it: the freshest fetch is the rendered truth, a stale
  // twin never double-counts in the median, and a disagreeing twin is logged
  // as a divergence (the single currency conversion per offer happens on the
  // one survivor that reaches the render).
  const byListing = new Map<string, H>();
  const divergentKeys = new Set<string>();
  for (const h of hits) {
    const key = `${h.merchant.toLowerCase()}|${normalizedListingUrlOf(h.url)}`;
    const prev = byListing.get(key);
    if (!prev) {
      byListing.set(key, h);
      continue;
    }
    const a = kwdSanityValue(prev.price, prev.currency);
    const b = kwdSanityValue(h.price, h.currency);
    if (a != null && b != null && Math.abs(a - b) > 1e-9) divergentKeys.add(key);
    if (fresher(h, prev)) byListing.set(key, h);
  }

  const deduped = [...byListing.values()];
  summary.cohortOffers = deduped.length;
  summary.priceDivergences = divergentKeys.size;
  for (const h of deduped) {
    (summary.perAdapter[h.merchant] ??= { offers: 0, flagged: 0 }).offers += 1;
  }

  // Partition the cohort: priceable (E3-clean, convertible, host-consistent)
  // vs flagged-first with the reason that excluded it.
  const priceable: { hit: H; kwd: number }[] = [];
  const preFlagged = new Map<H, SanityReason>();
  for (const h of deduped) {
    const v = kwdSanityValue(h.price, h.currency);
    if (v == null && (!Number.isFinite(h.price) || h.price <= 0)) {
      preFlagged.set(h, "price_unavailable"); // E3
      continue;
    }
    if (v == null) {
      preFlagged.set(h, "currency_mis_map"); // E4: conversion failed
      continue;
    }
    if (currencyMisMap(h.url, h.currency)) {
      preFlagged.set(h, "currency_mis_map"); // AC-5: host vs currency disagree
      continue;
    }
    priceable.push({ hit: h, kwd: v });
  }
  summary.priceableOffers = priceable.length;

  // FR-1.5/E1 — tiny cohort: skip the outlier check, log it, flag nothing.
  const skipped = priceable.length < SANITY_MIN_COHORT;
  const median = skipped ? null : medianOf(priceable.map((p) => p.kwd));
  summary.medianKwd = median == null ? null : Math.round(median * 1000) / 1000;
  summary.outlierCheckSkipped = skipped;

  const byOffer = new Map<H, OfferSanity>();
  const flag = (h: H, reason: SanityReason, ratio?: number) => {
    byOffer.set(
      h,
      ratio === undefined
        ? { status: "flagged", reason }
        : { status: "flagged", reason, ratioToMedian: ratio },
    );
    summary.flaggedByReason[reason] = (summary.flaggedByReason[reason] ?? 0) + 1;
    (summary.perAdapter[h.merchant] ??= { offers: 0, flagged: 0 }).flagged += 1;
  };
  for (const [h, reason] of preFlagged) flag(h, reason);

  if (!skipped && median != null && median > 0) {
    for (const { hit, kwd } of priceable) {
      const ratio = kwd / median;
      // E6 — boundary inclusive-by-exclusion: exactly `bound` does NOT flag.
      if (ratio > ratioBound) flag(hit, "outlier_high", ratio);
      else if (ratio < 1 / ratioBound) flag(hit, "outlier_low", ratio);
      else byOffer.set(hit, { status: "ok", ratioToMedian: ratio });
    }
  } else {
    for (const { hit } of priceable) byOffer.set(hit, { status: "ok" });
  }

  return { byOffer, summary, deduped };
}

/** E5 — freshest fetch wins; an offer with no stamp loses to one with one. */
function fresher(a: { collectedAt?: string }, b: { collectedAt?: string }): boolean {
  const ta = Date.parse(a.collectedAt ?? "");
  const tb = Date.parse(b.collectedAt ?? "");
  if (Number.isNaN(tb)) return !Number.isNaN(ta);
  if (Number.isNaN(ta)) return false;
  return ta > tb;
}

/**
 * AC-7 — the one structured log line per render. Plain console line (the
 * repo's server-log convention, cf. the event route) so Vercel log drains
 * pick it up without new infra; the metrics fold reads it from there.
 */
export function logSanitySummary(summary: SanitySummary): void {
  console.info(`[price-sanity] ${JSON.stringify(summary)}`);
}
