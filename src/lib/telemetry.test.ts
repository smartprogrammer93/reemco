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
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36",
      sendBeacon: beacon,
    });
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

// REEA-981 (AC-4, R2 spec FR-3.2) — bot/health-check traffic contributes
// zero events to any rate the FR-4 read uses. The server render tail gates on
// the shared isBotUserAgent predicate; the client transport is the other half
// of the same gate, at the single chokepoint every client emitter rides. Only
// the v1 stream is filtered — the REEA-37 funnel contract is out of the
// events spec's scope, so funnel beacons pass unchanged.
describe("trackEvents bot-UA gate (REEA-981 AC-4)", () => {
  const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const HEADLESS_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0 Safari/537.36";

  it("drops v1 events but keeps funnel events under a bot UA (mixed batch)", async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { userAgent: HEADLESS_UA, sendBeacon: beacon });
    trackEvents([
      { type: "offer_rendered", schema: 1, queryId: "q1", retailer: "Xcite", hasCoupon: true, priceSanityStatus: "ok" },
      { type: "coupon_hit", schema: 1, queryId: "q1", retailer: "Xcite", offerId: "o1" },
      { type: "search_submitted", query: "kindle", result_count: 3 },
    ]);
    expect(beacon).toHaveBeenCalledOnce();
    const body = JSON.parse(
      await (beacon.mock.calls[0] as unknown as [string, Blob])[1].text(),
    );
    expect(body.events).toEqual([{ type: "search_submitted", query: "kindle", result_count: 3 }]);
  });

  it("sends nothing when a bot UA batch is all v1 (F-D shape)", () => {
    const beacon = vi.fn(() => true);
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("navigator", { userAgent: HEADLESS_UA, sendBeacon: beacon });
    vi.stubGlobal("fetch", fetchMock);
    trackEvents([
      { type: "offer_rendered", schema: 1, queryId: "q1", retailer: "Jarir", hasCoupon: false, priceSanityStatus: null },
      { type: "result_click", schema: 1, queryId: "q1", offerId: "o1", retailer: "Jarir", position: 2 },
    ]);
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends v1 events unchanged under a shopper UA", async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { userAgent: BROWSER_UA, sendBeacon: beacon });
    trackEvents([
      { type: "offer_rendered", schema: 1, queryId: "q1", retailer: "Eureka", hasCoupon: true, priceSanityStatus: "ok" },
    ]);
    expect(beacon).toHaveBeenCalledOnce();
    const body = JSON.parse(
      await (beacon.mock.calls[0] as unknown as [string, Blob])[1].text(),
    );
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe("offer_rendered");
  });

  it("treats a missing UA as bot traffic (shared predicate contract)", () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    trackEvents([
      { type: "offer_rendered", schema: 1, queryId: "q1", retailer: "Sultan Center", hasCoupon: false, priceSanityStatus: null },
    ]);
    expect(beacon).not.toHaveBeenCalled();
  });
});
