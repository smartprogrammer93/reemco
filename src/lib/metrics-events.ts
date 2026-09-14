/**
 * REEA-965 — v1 metrics event builders (R2 spec FR-3, schema 1).
 *
 * Pure constructors so every emitter (server render tail, client click
 * handlers, client converged-set effect) produces byte-identical shapes and
 * the schema lives in exactly one place next to its validation
 * (src/lib/events.ts). Fire-and-forget contract (AC-9): builders never
 * await, never throw into callers, and the payloads carry ONLY the spec's
 * properties — queryId is a per-query-execution random id and is the sole
 * identifier in any payload (AC-8, spec §7 data minimization).
 *
 * Coupon-hit rate per retailer = coupon_hit / offer_rendered per retailer
 * (FR-3.3) — the R4 investment decision input. `priceSanityStatus` reuses
 * R1's flag annotation; until R1 (REEA-963) lands it is emitted as null
 * per the spec's cross-spec dependency note — this spec must not block on
 * R1.
 */
import { V1_SCHEMA_VERSION, type FunnelEvent } from "@/lib/events";

/** A v1 event without the store-assigned id/ts. */
export type V1Event = Omit<FunnelEvent, "id" | "ts">;

/** Minimal card-level facts the rendered results set carries per offer. */
export interface RenderedOffer {
  /** The rendered card's product id — the clickable offer surface on results. */
  offerId: string;
  /** The merchant whose offer leads the card (the one the CTA acts on). */
  retailer: string;
  /** The card's coupon module shows ≥1 available coupon for this offer. */
  hasCoupon: boolean;
  /** R1 sanity flag annotation; absent/null emits null (pre-R1 contract). */
  priceSanityStatus?: string | null;
}

export function buildSearchPerformed(args: {
  queryId: string;
  query: string;
  resultCount: number;
  relatedCount: number;
}): V1Event {
  return {
    type: "search_performed",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    query: args.query,
    resultCount: args.resultCount,
    relatedCount: args.relatedCount,
  };
}

export function buildZeroResultShown(args: {
  queryId: string;
  query: string;
  relatedCount: number;
}): V1Event {
  return {
    type: "zero_result_shown",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    query: args.query,
    relatedCount: args.relatedCount,
  };
}

export function buildResultClick(args: {
  queryId: string;
  offerId: string;
  retailer: string;
  position: number;
}): V1Event {
  return {
    type: "result_click",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    offerId: args.offerId,
    retailer: args.retailer,
    position: args.position,
  };
}

/** `position` is pinned to 1 by definition (first card in primary results). */
export function buildFirstResultClick(args: {
  queryId: string;
  offerId: string;
  retailer: string;
}): V1Event {
  return {
    type: "first_result_click",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    offerId: args.offerId,
    retailer: args.retailer,
    position: 1,
  };
}

/** Fires from the R2 related-accessory section (REEA-964); schema ships here. */
export function buildRelatedClick(args: {
  queryId: string;
  offerId: string;
  retailer: string;
}): V1Event {
  return {
    type: "related_click",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    offerId: args.offerId,
    retailer: args.retailer,
  };
}

export function buildOfferRendered(args: {
  queryId: string;
  retailer: string;
  hasCoupon: boolean;
  /** R1 sanity flag annotation, or null while R1 has not landed. */
  priceSanityStatus: string | null;
}): V1Event {
  return {
    type: "offer_rendered",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    retailer: args.retailer,
    hasCoupon: args.hasCoupon,
    priceSanityStatus: args.priceSanityStatus,
  };
}

export function buildCouponHit(args: {
  queryId: string;
  retailer: string;
  offerId: string;
}): V1Event {
  return {
    type: "coupon_hit",
    schema: V1_SCHEMA_VERSION,
    queryId: args.queryId,
    retailer: args.retailer,
    offerId: args.offerId,
  };
}

/**
 * Server-side render events for one query execution (spec: search_performed
 * fires server-side at render; zero_result_shown when the primary results
 * section holds zero confident matches). The R2 confidence hierarchy
 * (REEA-964) will pass the classified split; until it lands every rendered
 * result is a primary result and relatedCount is 0 — the same definition the
 * page's zero state uses today, so the metric never counts a zero the page
 * did not show.
 */
export function buildRenderEvents(args: {
  queryId: string;
  query: string;
  primaryCount: number;
  relatedCount: number;
}): V1Event[] {
  const events: V1Event[] = [
    buildSearchPerformed({
      queryId: args.queryId,
      query: args.query,
      resultCount: args.primaryCount,
      relatedCount: args.relatedCount,
    }),
  ];
  if (args.primaryCount === 0) {
    events.push(
      buildZeroResultShown({
        queryId: args.queryId,
        query: args.query,
        relatedCount: args.relatedCount,
      }),
    );
  }
  return events;
}

/**
 * Per-rendered-offer events for one converged results set: offer_rendered
 * per rendered card, coupon_hit exactly where the card's coupon module has
 * an offer (FR-3.3's numerator/denominator, emitted from the same pass so
 * the ratio can never drift between two snapshots). `priceSanityStatus` is
 * null until R1 lands.
 */
export function buildOfferRenderedEvents(args: {
  queryId: string;
  offers: RenderedOffer[];
}): V1Event[] {
  const events: V1Event[] = [];
  for (const offer of args.offers) {
    events.push(
      buildOfferRendered({
        queryId: args.queryId,
        retailer: offer.retailer,
        hasCoupon: offer.hasCoupon,
        priceSanityStatus: offer.priceSanityStatus ?? null,
      }),
    );
    if (offer.hasCoupon) {
      events.push(
        buildCouponHit({
          queryId: args.queryId,
          retailer: offer.retailer,
          offerId: offer.offerId,
        }),
      );
    }
  }
  return events;
}
