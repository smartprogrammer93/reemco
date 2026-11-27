/**
 * REEA-1237 — shopper-basis offer-link CTR.
 *
 * The W48 read paired a browser click beacon (offer_link_clicks = 5) with a
 * SERVER serve count (ctr_denominator_clean = 24,509) that included crawler
 * fetches which never executed the page → 0.02%, not decision-grade. The fix
 * publishes the denominator on the same basis as the numerator: client
 * page-view beacons, i.e. serves a shopper's browser actually executed.
 *
 * Pins:
 * - AC-1: the payload exposes `shopper_serves` and `ctr_denominator_shopper`
 *   as aggregate integers.
 * - AC-2: `offer_link_ctr_shopper` is published and `methodology` names the
 *   numerator and denominator bases.
 * - AC-4: the ratio is reproducible from the payload alone (clicks ÷ serves).
 * - AC-5: the `page_view` event stores no identifier — validation strips
 *   everything but the type, and the payload carries integers only.
 */
import { describe, expect, it } from "vitest";
import { CTR_EVENT_TYPES, EVENT_TYPES, FUNNEL_EVENT_TYPES, V1_EVENT_TYPES, validateEvent } from "@/lib/events";
import type { FunnelEvent } from "@/lib/events";
import { pageViewsByWeek, weeklyResponse } from "@/app/api/metrics/weekly/route";
import { emptyWeek, isoWeekKey, type WeekCountersMap } from "@/lib/metrics";

const WEEK_MS = Date.UTC(2026, 10, 25); // a UTC day inside the week under test
const WEEK = isoWeekKey(WEEK_MS);
const OTHER_WEEK_MS = WEEK_MS - 7 * 24 * 60 * 60 * 1000;

function view(ts: string): FunnelEvent {
  return { id: `e-${ts}-${Math.random()}`, ts, type: "page_view" };
}

describe("REEA-1237 AC-5 — the page_view beacon persists no identifier", () => {
  it("accepts a bare page_view and stores only the type", () => {
    const res = validateEvent({ type: "page_view" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event).toEqual({ type: "page_view" });
  });

  it("strips every client-supplied property, so no query/session/user id lands", () => {
    const res = validateEvent({
      type: "page_view",
      query: "sony",
      queryId: "per-query-random",
      schema: 1,
      rank: 3,
      item_id: "p1",
      outbound_url: "https://xcite.example/x",
      result_count: 2,
      retailer: "Xcite",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event).toEqual({ type: "page_view" });
  });

  it("is a CTR event, not a funnel or v1 event (so it does not inherit funnel semantics)", () => {
    expect(EVENT_TYPES).toContain("page_view");
    expect(CTR_EVENT_TYPES).toEqual(["page_view"]);
    expect((FUNNEL_EVENT_TYPES as readonly string[]).includes("page_view")).toBe(false);
    expect((V1_EVENT_TYPES as readonly string[]).includes("page_view")).toBe(false);
  });
});

describe("REEA-1237 — page views are the shopper serve basis, per ISO week", () => {
  it("counts only page_view beacons, bucketed by their ingestion week", () => {
    const events: FunnelEvent[] = [
      view(new Date(WEEK_MS).toISOString()),
      view(new Date(WEEK_MS + 3_600_000).toISOString()),
      view(new Date(OTHER_WEEK_MS).toISOString()),
      // other event types never enter the shopper denominator
      { id: "c1", ts: new Date(WEEK_MS).toISOString(), type: "item_clicked", rank: 0, item_id: "p1", outbound_url: "https://x.example/p1" },
      { id: "s1", ts: new Date(WEEK_MS).toISOString(), type: "search_submitted", query: "sony", result_count: 3 },
      // corrupt timestamp is dropped, not counted as a serve
      view("not-a-date"),
    ];
    const byWeek = pageViewsByWeek(events);
    expect(byWeek[WEEK]).toBe(2);
    expect(byWeek[isoWeekKey(OTHER_WEEK_MS)]).toBe(1);
  });
});

describe("REEA-1237 AC-1/AC-2/AC-4 — shopper-basis CTR on the payload", () => {
  it("publishes shopper_serves and ctr_denominator_shopper as the same aggregate integer", async () => {
    const weeks: WeekCountersMap = { [WEEK]: emptyWeek() };
    weeks[WEEK].searches = 900; // server serves include crawlers; not the CTR basis
    const res = weeklyResponse(
      { weeks, source: "local", kvReadFailed: false },
      { [WEEK]: 3 },
      8,
      { [WEEK]: 1_200 },
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      methodology: Record<string, string>;
    };
    const w = body.weeks[WEEK];
    expect(w.shopper_serves).toBe(1_200);
    expect(w.ctr_denominator_shopper).toBe(1_200);
    // AC-4 — reproducible from the payload alone.
    expect(w.offer_link_ctr_shopper).toBe(3 / 1_200);
    expect(w.offer_link_clicks).toBe(3);
    // Continuity: the server-basis denominator is still published.
    expect(w.ctr_denominator_clean).toBe(900);
    // AC-2 — both bases are named in methodology.
    const m = body.methodology.ctr_shopper;
    expect(m).toContain("offer_link_clicks");
    expect(m).toContain("page_view");
    expect(m).toContain("ctr_denominator_shopper");
    expect(m).toContain("null when a week has no shopper serve");
    expect(m).toContain("0.55%");
  });

  it("never publishes a 0% rate when the basis is absent: null, not 0", async () => {
    const res = weeklyResponse(
      { weeks: { [WEEK]: emptyWeek() }, source: "local", kvReadFailed: false },
      { [WEEK]: 5 },
      8,
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, unknown>> };
    const w = body.weeks[WEEK];
    expect(w.shopper_serves).toBe(0);
    expect(w.ctr_denominator_shopper).toBe(0);
    expect(w.offer_link_ctr_shopper).toBeNull();
  });

  it("is aggregate-only: the shopper CTR fields are integers/fraction/null, no identifier", async () => {
    const res = weeklyResponse(
      { weeks: { [WEEK]: emptyWeek() }, source: "local", kvReadFailed: false },
      { [WEEK]: 2 },
      8,
      { [WEEK]: 4 },
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, unknown>> };
    const w = body.weeks[WEEK];
    for (const key of ["shopper_serves", "ctr_denominator_shopper"]) {
      expect(Number.isInteger(w[key])).toBe(true);
    }
    expect(typeof w.offer_link_ctr_shopper).toBe("number");
    // The week object carries no scalar strings at all (the only strings are
    // methodology prose and the retailer-name keys of the maps).
    expect(Object.values(w).filter((v) => typeof v === "string")).toHaveLength(0);
    // No query text, no id, no UA anywhere in the serialized week.
    const serialized = JSON.stringify(w);
    expect(serialized).not.toContain("sony");
    expect(serialized).not.toMatch(/"queryId"/);
    expect(serialized).not.toMatch(/"session/);
  });

  it("keeps the ratio bounded by the two published integers (no cross-source blending)", async () => {
    const weeks: WeekCountersMap = { [WEEK]: emptyWeek() };
    weeks[WEEK].searches = 10_000; // hostile server basis, must not leak into CTR
    const res = weeklyResponse(
      { weeks, source: "local", kvReadFailed: false },
      { [WEEK]: 4 },
      8,
      { [WEEK]: 1_000 },
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, number>> };
    const w = body.weeks[WEEK];
    expect(w.offer_link_ctr_shopper).toBe((w.offer_link_clicks as number) / (w.shopper_serves as number));
    expect(w.offer_link_ctr_shopper).toBe(0.004);
    // 0.4% on the shopper basis, not 0.04% against the server count.
    expect(w.offer_link_ctr_shopper).toBeLessThan(0.0055);
  });
});
