// @vitest-environment jsdom
/**
 * REEA-37 — client telemetry transport tests (AC-3).
 * jsdom provides window/navigator; we stub sendBeacon and fetch to observe
 * the outgoing payload and assert no cookies/localStorage are touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackEvent, trackEvents } from "@/lib/telemetry";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trackEvents transport", () => {
  it("prefers navigator.sendBeacon with a JSON blob", async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    trackEvent({ type: "zero_results", query: "q1" });
    expect(beacon).toHaveBeenCalledOnce();
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe("/api/events");
    expect(JSON.parse(await blob.text())).toEqual({ events: [{ type: "zero_results", query: "q1" }] });
  });

  it("falls back to keepalive fetch when sendBeacon is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    trackEvents([{ type: "search_submitted", query: "q2", result_count: 4 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ type: "search_submitted", query: "q2", result_count: 4 }],
    });
  });

  it("never throws into the UI when the transport fails", () => {
    vi.stubGlobal("navigator", {
      sendBeacon: () => {
        throw new Error("boom");
      },
    });
    vi.stubGlobal("fetch", () => {
      throw new Error("boom");
    });
    expect(() => trackEvent({ type: "zero_results", query: "q3" })).not.toThrow();
  });

  it("does not touch document.cookie or localStorage (AC-3)", () => {
    const cookieSet = vi.fn();
    Object.defineProperty(document, "cookie", { set: cookieSet, get: () => "" });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    trackEvent({ type: "zero_results", query: "q4" });
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});

// REEA-965 — render batches (offer_rendered per card) can exceed the
// endpoint's per-request cap; the transport must chunk or the tail is
// silently rejected at ingestion.
describe("trackEvents chunking (REEA-965)", () => {
  it("splits batches larger than MAX_EVENTS_PER_REQUEST across beacons", async () => {
    const { MAX_EVENTS_PER_REQUEST } = await import("@/lib/events");
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 3 }, (_, i) => ({
      type: "offer_rendered" as const,
      schema: 1,
      queryId: `q${i}`,
      retailer: "Xcite",
      hasCoupon: false,
      priceSanityStatus: null,
    }));
    trackEvents(events);
    expect(beacon).toHaveBeenCalledTimes(2);
    const first = JSON.parse(
      await (beacon.mock.calls[0] as unknown as [string, Blob])[1].text(),
    );
    const second = JSON.parse(
      await (beacon.mock.calls[1] as unknown as [string, Blob])[1].text(),
    );
    expect(first.events).toHaveLength(MAX_EVENTS_PER_REQUEST);
    expect(second.events).toHaveLength(3);
  });

  it("sends a single beacon when the batch fits", () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    trackEvents([{ type: "zero_results", query: "q" }]);
    expect(beacon).toHaveBeenCalledOnce();
  });
});
