/**
 * REEA-1069 — Direction A "Shelf" offer verification status (REEA-1055 spec
 * §3 status system, token diff §2, RTL checklist §A).
 *
 * ONE status token per offer, never on a variant chip. The three states are
 * carried by icon shape + label + tooltip, not by colour alone, so the token
 * is colour-blind safe and cannot out-shout the price.
 *
 * The mapping is deliberately conservative and derives ONLY from data the
 * live fan-out actually carries (no invented registry, no second fetch):
 *
 *  - Stale: the offer's own collection stamp is older than 24 hours. The
 *    tooltip says exactly that ("Collected more than 24 hours ago").
 *  - Needs verification: the offer was collected but not cross-checked in
 *    this run — a snapshot replay (fromSnapshot), a cached replay on the
 *    product collector (method "cache"), an offer with no usable collection
 *    stamp, or a query-time sanity flag (the price looked unusual). The
 *    tooltip says it is indicative.
 *  - Verified: a live answer from this collection run whose price passed the
 *    cohort sanity check. The tooltip names the cross-check.
 *
 * A missing/unparseable stamp is "Needs verification", never "Verified":
 * honesty cuts both ways. Ranking is untouched — this module only labels.
 */

import type { PriceOffer } from "@/types/product";

export type OfferStatus = "verified" | "unverified" | "stale";

export const OFFER_STATUS_STALE_MS = 24 * 60 * 60 * 1000;

export interface OfferStatusInput {
  collectedAt?: string;
  /** REEA-510 snapshot replay — collected earlier, not by this run. */
  fromSnapshot?: boolean;
  /** Product-collector replay label ("cache" on LiveOffer). */
  cached?: boolean;
  /** Query-time sanity verdict; flagged means the figure looked unusual. */
  flagged?: boolean;
}

/**
 * Pure, deterministic status derivation. `nowMs` is the caller's baked
 * render clock (server render start), so SSR and hydration agree.
 */
export function offerStatusOf(input: OfferStatusInput, nowMs: number): OfferStatus {
  const stampMs = input.collectedAt ? Date.parse(input.collectedAt) : NaN;
  const hasStamp = Number.isFinite(stampMs);
  const ageMs = hasStamp ? Math.max(0, nowMs - stampMs) : Infinity;

  if (hasStamp && ageMs > OFFER_STATUS_STALE_MS) return "stale";
  if (input.flagged || input.fromSnapshot || input.cached || !hasStamp) return "unverified";
  return "verified";
}

/** Convenience for a NormalizedProduct offer row. */
export function offerStatusForOffer(offer: PriceOffer, nowMs: number): OfferStatus {
  return offerStatusOf(
    {
      collectedAt: offer.collectedAt,
      fromSnapshot: offer.fromSnapshot,
      flagged: offer.sanity?.status === "flagged",
    },
    nowMs,
  );
}

/** Convenience for a product-page LiveOffer row. */
export function offerStatusForLiveOffer(
  offer: { collectedAt?: string; method?: "live" | "cache" },
  nowMs: number,
): OfferStatus {
  return offerStatusOf(
    { collectedAt: offer.collectedAt, cached: offer.method === "cache" },
    nowMs,
  );
}
