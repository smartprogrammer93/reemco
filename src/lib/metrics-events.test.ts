import { describe, expect, it } from "vitest";
import {
  buildRenderEvents,
  buildOfferRenderedEvents,
  buildFirstResultClick,
  buildResultClick,
  buildRelatedClick,
  priceSanityStatusOf,
} from "@/lib/metrics-events";
import { validateEvent } from "@/lib/events";

/** REEA-965 — v1 builders produce shapes that survive their own ingestion
 *  validation, and the render/offer event families stay exactly aligned with
 *  the R2 spec table (FR-3) and its metric definitions (FR-3.3/FR-3.4). */
describe("metrics-events builders", () => {
  const queryId = "3f2c9ab0-1c4d-4e5f-8a9b-001122334455";

  it("search_performed carries queryId, query, resultCount, relatedCount, schema", () => {
    const [ev] = buildRenderEvents({ queryId, query: "iphone 17 pro", primaryCount: 4, relatedCount: 6 });
    expect(ev).toEqual({
      type: "search_performed",
      schema: 1,
      queryId,
      query: "iphone 17 pro",
      resultCount: 4,
      relatedCount: 6,
    });
    expect(validateEvent(ev).ok).toBe(true);
  });

  it("emits zero_result_shown exactly when the primary set is empty", () => {
    const zero = buildRenderEvents({ queryId, query: "zzqqxx", primaryCount: 0, relatedCount: 0 });
    expect(zero.map((e) => e.type)).toEqual(["search_performed", "zero_result_shown"]);
    expect(zero[1]).toMatchObject({ queryId, query: "zzqqxx", relatedCount: 0, schema: 1 });
    const nonZero = buildRenderEvents({ queryId, query: "iphone", primaryCount: 3, relatedCount: 1 });
    expect(nonZero.map((e) => e.type)).toEqual(["search_performed"]);
    for (const ev of [...zero, ...nonZero]) expect(validateEvent(ev).ok).toBe(true);
  });

  it("offer_rendered fires per offer and coupon_hit exactly where hasCoupon", () => {
    const events = buildOfferRenderedEvents({
      queryId,
      offers: [
        { offerId: "p1", retailer: "Xcite", hasCoupon: true },
        { offerId: "p2", retailer: "Jarir", hasCoupon: false },
        { offerId: "p3", retailer: "Xcite", hasCoupon: true, priceSanityStatus: "outlier_high" },
      ],
    });
    const rendered = events.filter((e) => e.type === "offer_rendered");
    const hits = events.filter((e) => e.type === "coupon_hit");
    expect(rendered).toHaveLength(3);
    expect(hits.map((h) => h.offerId)).toEqual(["p1", "p3"]);
    expect(rendered[0]).toMatchObject({ retailer: "Xcite", hasCoupon: true, priceSanityStatus: null, schema: 1 });
    expect(rendered[2]).toMatchObject({ retailer: "Xcite", hasCoupon: true, priceSanityStatus: "outlier_high" });
    for (const ev of events) expect(validateEvent(ev).ok).toBe(true);
  });

  it("priceSanityStatus defaults to null when R1 has not landed", () => {
    const [rendered] = buildOfferRenderedEvents({
      queryId,
      offers: [{ offerId: "p1", retailer: "Eureka", hasCoupon: false }],
    });
    expect(rendered).toMatchObject({ priceSanityStatus: null, hasCoupon: false });
    // No coupon_hit sibling when the card carries no coupon.
    const events = buildOfferRenderedEvents({
      queryId,
      offers: [{ offerId: "p1", retailer: "Eureka", hasCoupon: false }],
    });
    expect(events.filter((e) => e.type === "coupon_hit")).toHaveLength(0);
  });

  it("click builders pin first_result_click position to 1", () => {
    expect(buildFirstResultClick({ queryId, offerId: "p1", retailer: "Xcite" })).toMatchObject({
      type: "first_result_click",
      position: 1,
      schema: 1,
    });
    expect(buildResultClick({ queryId, offerId: "p2", retailer: "Jarir", position: 4 })).toMatchObject({
      type: "result_click",
      position: 4,
    });
    expect(buildRelatedClick({ queryId, offerId: "p9", retailer: "Eureka" })).toMatchObject({
      type: "related_click",
      schema: 1,
    });
    expect(
      validateEvent(buildFirstResultClick({ queryId, offerId: "p1", retailer: "Xcite" })).ok,
    ).toBe(true);
  });
});

// REEA-963 R1 interop — the sanity verdict maps onto priceSanityStatus so the
// flagged-rate per adapter (R1 §10) is derivable from the event stream alone.
describe("priceSanityStatusOf (REEA-965 <-> R1)", () => {
  it("maps ok / flagged-reason / never-ran distinctly", () => {
    expect(priceSanityStatusOf({ status: "ok" })).toBe("ok");
    expect(priceSanityStatusOf({ status: "flagged", reason: "currency_mis_map" })).toBe("currency_mis_map");
    expect(priceSanityStatusOf(undefined)).toBeNull();
  });
});
