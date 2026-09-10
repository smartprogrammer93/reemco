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
