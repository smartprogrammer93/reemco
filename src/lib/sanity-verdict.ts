/**
 * REEA-1178 — the sanity-verdict predicate every comparison surface reads.
 *
 * This module is deliberately dependency-free (no imports at all) so both the
 * server-side metrics fold and the client-side market/headline helpers can
 * share ONE definition without an import cycle: `lib/market.ts` imports it to
 * keep a possible-mismatch offer out of the headline price, and
 * `lib/offer-integrity.ts` imports it to keep the same offer out of the
 * retailer count and `comparison_depth`.
 *
 * The rule (ticket scope, AC3): an offer is a POSSIBLE MISMATCH when
 *  - its `ratioToMedian < 0.1` (the live Anker/Amazon.eg accessory sat at
 *    0.09997 and was `ok`, so the collector's 15× cohort bound did not flag
 *    it), or
 *  - it carries a price-integrity flag (`currency_mis_map`,
 *    `price_unavailable`), or
 *  - it is flagged `outlier_low`.
 *
 * `outlier_high` is NOT a mismatch: it is the same product priced above a
 * skewed cohort (live `fold 7`: every phone at 65–107× because the cohort
 * median is set by KD 4.9 cases). Excluding it would blank the retailer count
 * on a card with four real stores. An offer with no verdict is not a mismatch
 * either — absent evidence is not a defect.
 */

/** AC3 — the ticket's possible-mismatch threshold. */
export const POSSIBLE_MISMATCH_RATIO = 0.1;

/** The minimum sanity payload the predicate reads. */
export interface SanityBearing {
  sanity?: { status?: string; reason?: string; ratioToMedian?: number };
}

/** True when the query-time sanity pass flagged this offer. */
export function isFlaggedOffer(offer: SanityBearing): boolean {
  return offer.sanity?.status === "flagged";
}

/** True when this offer is not comparable evidence for the card (AC3). */
export function isPossibleMismatchOffer(offer: SanityBearing): boolean {
  const sanity = offer.sanity;
  if (!sanity) return false;
  const ratio = sanity.ratioToMedian;
  if (sanity.reason === "currency_mis_map" || sanity.reason === "price_unavailable") return true;
  if (sanity.reason === "outlier_low") return ratio == null || ratio < POSSIBLE_MISMATCH_RATIO;
  if (sanity.status === "ok") return typeof ratio === "number" && ratio < POSSIBLE_MISMATCH_RATIO;
  return false;
}
