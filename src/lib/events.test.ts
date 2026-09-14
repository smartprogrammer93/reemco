import { describe, expect, it } from "vitest";
import { validateEvent, validateEventBatch, MAX_EVENTS_PER_REQUEST } from "@/lib/events";

const base = { query: "iphone 15 case" };

describe("validateEvent", () => {
  it("accepts all five funnel event shapes with correct fields", () => {
    expect(validateEvent({ type: "search_submitted", ...base, result_count: 12 })).toMatchObject({
      ok: true,
    });
    expect(validateEvent({ type: "result_impressed", ...base, rank: 0, item_id: "p-1" })).toMatchObject({
      ok: true,
    });
    expect(
      validateEvent({
        type: "item_clicked",
        ...base,
        rank: 3,
        item_id: "p-1",
        outbound_url: "https://merchant.example/buy?id=p-1",
      }),
    ).toMatchObject({ ok: true });
    expect(validateEvent({ type: "zero_results", ...base })).toMatchObject({ ok: true });
    // REEA-541: the fifth type rides query (+ optional item_id) only.
    expect(validateEvent({ type: "summary_copied", ...base })).toMatchObject({ ok: true });
    expect(
      validateEvent({ type: "summary_copied", ...base, item_id: "p-1" }),
    ).toMatchObject({ ok: true });
  });

  it("rejects search_submitted without result_count", () => {
    expect(validateEvent({ type: "search_submitted", ...base }).ok).toBe(false);
  });

  it("rejects item_clicked missing rank/item_id/outbound_url", () => {
    const ev = { type: "item_clicked", ...base, item_id: "p-1" };
    expect(validateEvent(ev).ok).toBe(false);
    expect(validateEvent({ ...ev, rank: 0 }).ok).toBe(false);
    expect(validateEvent({ ...ev, rank: 0, outbound_url: "https://x.example/y" }).ok).toBe(true);
  });

  it("rejects non-http(s) outbound URLs (SSRF/javascript: guard)", () => {
    expect(
      validateEvent({
        type: "item_clicked",
        ...base,
        rank: 0,
        item_id: "p",
        outbound_url: "javascript:alert(1)",
      }).ok,
    ).toBe(false);
    expect(
      validateEvent({
        type: "item_clicked",
        ...base,
        rank: 0,
        item_id: "p",
        outbound_url: "not a url",
      }).ok,
    ).toBe(false);
  });

  it("strips control characters and enforces field bounds", () => {
    const res = validateEvent({
      type: "zero_results",
      query: "head\u0007phones",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event.query).toBe("headphones");

    expect(validateEvent({ type: "zero_results", query: "q".repeat(201) }).ok).toBe(false);
    expect(validateEvent({ type: "search_submitted", query: "q", result_count: -1 }).ok).toBe(false);
    expect(validateEvent({ type: "search_submitted", query: "q", result_count: 1.5 }).ok).toBe(false);
    expect(validateEvent({ type: "result_impressed", query: "q", rank: 1e9, item_id: "p" }).ok).toBe(false);
  });

  it("rejects unknown event types and empty queries", () => {
    expect(validateEvent({ type: "page_view", query: "q" }).ok).toBe(false);
    expect(validateEvent({ type: "zero_results", query: "   " }).ok).toBe(false);
  });
});

describe("validateEventBatch", () => {
  it("accepts a batch and counts rejects separately", () => {
    const res = validateEventBatch({
      events: [
        { type: "search_submitted", ...base, result_count: 3 },
        { type: "zero_results", query: "zzz" },
        { type: "nonsense" },
      ],
    });
    expect(res.accepted).toHaveLength(2);
    expect(res.rejected).toBe(1);
  });

  it("accepts a single bare event object", () => {
    const res = validateEventBatch({ type: "zero_results", query: "q" });
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected).toBe(0);
  });

  it("caps the batch size", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 5 }, () => ({
      type: "zero_results",
      query: "q",
    }));
    const res = validateEventBatch({ events });
    expect(res.accepted).toHaveLength(MAX_EVENTS_PER_REQUEST);
    expect(res.rejected).toBe(5);
  });
});

// REEA-965 — v1 metrics events (R2 spec FR-3 table, schema 1). Exact names,
// exact properties, data minimization (no PII field exists in the schema).
describe("validateEvent v1 (REEA-965)", () => {
  const qid = { schema: 1, queryId: "3f2c9ab0-1c4d-4e5f-8a9b-001122334455" };

  it("accepts each v1 type with exactly the spec properties", () => {
    expect(
      validateEvent({
        type: "search_performed",
        ...qid,
        query: "iphone 17 pro",
        resultCount: 4,
        relatedCount: 6,
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateEvent({ type: "zero_result_shown", ...qid, query: "zzqqxx", relatedCount: 0 }),
    ).toMatchObject({ ok: true });
    expect(
      validateEvent({ type: "first_result_click", ...qid, offerId: "p1", retailer: "Xcite", position: 1 }),
    ).toMatchObject({ ok: true });
    expect(
      validateEvent({ type: "result_click", ...qid, offerId: "p2", retailer: "Jarir", position: 3 }),
    ).toMatchObject({ ok: true });
    expect(
      validateEvent({ type: "related_click", ...qid, offerId: "p3", retailer: "Eureka" }),
    ).toMatchObject({ ok: true });
    expect(
      validateEvent({
        type: "offer_rendered",
        ...qid,
        retailer: "Sultan Center",
        hasCoupon: true,
        priceSanityStatus: null, // null until R1 lands (spec cross-dependency note)
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateEvent({ type: "coupon_hit", ...qid, retailer: "Xcite", offerId: "p1" }),
    ).toMatchObject({ ok: true });
  });

  it("keeps the stored payload to the validated shape (unknown fields stripped)", () => {
    const res = validateEvent({
      type: "coupon_hit",
      ...qid,
      retailer: "Xcite",
      offerId: "p1",
      // attempted PII — must never survive validation (AC-8 payload review)
      userId: "u-123",
      sessionId: "s-456",
      ip: "10.0.0.1",
      fingerprint: "abc",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event).not.toHaveProperty("userId");
      expect(res.event).not.toHaveProperty("sessionId");
      expect(res.event).not.toHaveProperty("fingerprint");
      expect(JSON.stringify(res.event)).not.toContain("u-123");
    }
  });

  it("rejects v1 events missing required properties or schema", () => {
    expect(validateEvent({ type: "search_performed", queryId: "q1", query: "x", resultCount: 1, relatedCount: 0 }).ok).toBe(false); // no schema
    expect(validateEvent({ type: "search_performed", schema: 1, query: "x", resultCount: 1, relatedCount: 0 }).ok).toBe(false); // no queryId
    expect(validateEvent({ type: "search_performed", schema: 1, queryId: "q1", resultCount: 1, relatedCount: 0 }).ok).toBe(false); // no query
    expect(validateEvent({ type: "search_performed", schema: 1, queryId: "q1", query: "x", relatedCount: 0 }).ok).toBe(false); // no resultCount
    expect(validateEvent({ type: "zero_result_shown", schema: 1, queryId: "q1", query: "x" }).ok).toBe(false); // no relatedCount
    expect(validateEvent({ type: "result_click", schema: 1, queryId: "q1", offerId: "p", retailer: "Xcite" }).ok).toBe(false); // no position
    expect(validateEvent({ type: "first_result_click", schema: 1, queryId: "q1", offerId: "p", retailer: "Xcite", position: 2 }).ok).toBe(false); // position pinned to 1
    expect(validateEvent({ type: "offer_rendered", schema: 1, queryId: "q1", retailer: "Xcite", hasCoupon: false }).ok).toBe(false); // no priceSanityStatus
    expect(validateEvent({ type: "coupon_hit", schema: 1, queryId: "q1", retailer: "Xcite" }).ok).toBe(false); // no offerId
    expect(validateEvent({ type: "search_performed", schema: 2, queryId: "q1", query: "x", resultCount: 1, relatedCount: 0 }).ok).toBe(false); // future schema
  });

  it("strips control characters from v1 tokens and bounds them", () => {
    const res = validateEvent({
      type: "result_click",
      schema: 1,
      queryId: "q\u00071",
      offerId: "p\u00071",
      retailer: "Xcite",
      position: 2,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event.queryId).toBe("q1");
      expect(res.event.offerId).toBe("p1");
    }
    expect(
      validateEvent({ type: "coupon_hit", schema: 1, queryId: "   ", retailer: "X", offerId: "p" }).ok,
    ).toBe(false);
  });

  it("round-trips a mixed funnel+v1 batch through ingestion validation", () => {
    const res = validateEventBatch({
      events: [
        { type: "search_performed", schema: 1, queryId: "q1", query: "iphone", resultCount: 2, relatedCount: 1 },
        { type: "zero_results", query: "iphone" },
        { type: "offer_rendered", schema: 1, queryId: "q1", retailer: "Xcite", hasCoupon: true, priceSanityStatus: null },
      ],
    });
    expect(res.accepted).toHaveLength(3);
    expect(res.rejected).toBe(0);
  });
});
