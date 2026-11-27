/**
 * REEA-1255 AC5(b) — the aggregate-only `share_whatsapp` click counter.
 *
 * Pins:
 * - the event validates with no properties at all (the aggregate integer is
 *   the whole persisted fact — no query, no session/user id);
 * - the weekly metrics payload exposes `share_whatsapp` per week plus the
 *   derived `share_whatsapp_per_1k_serves`, and `methodology` names both;
 * - an absent basis is null, never a misleading 0% rate.
 */
import { describe, expect, it } from "vitest";
import { validateEvent } from "@/lib/events";
import type { FunnelEvent } from "@/lib/events";
import { emptyWeek, isoWeekKey, type WeekCountersMap } from "@/lib/metrics";
import {
  sharesByWeek,
  weeklyResponse,
} from "@/app/api/metrics/weekly/route";

const WEEK_MS = Date.UTC(2026, 11, 2); // 2026-W49
const WEEK = isoWeekKey(WEEK_MS);

function share(ts: string): FunnelEvent {
  return { id: `s-${ts}`, ts, type: "share_whatsapp" };
}

describe("REEA-1255 AC5(b) — type-only event, no identifier", () => {
  it("accepts a bare share_whatsapp and stores only the type", () => {
    const res = validateEvent({ type: "share_whatsapp" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event).toEqual({ type: "share_whatsapp" });
  });

  it("strips every client-supplied property", () => {
    const res = validateEvent({
      type: "share_whatsapp",
      query: "iphone 15",
      queryId: "per-query-random",
      item_id: "apple-iphone-15",
      rank: 2,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event).toEqual({ type: "share_whatsapp" });
  });
});

describe("REEA-1255 AC5(b) — weekly payload counter + methodology", () => {
  it("counts share_whatsapp per ISO week", () => {
    const events = [
      share("2026-12-01T10:00:00.000Z"),
      share("2026-12-02T10:00:00.000Z"),
      share("2026-12-09T10:00:00.000Z"), // next week
    ];
    expect(sharesByWeek(events)).toEqual({ [WEEK]: 2, "2026-W50": 1 });
  });

  it("publishes the integer and the derived per-1,000-serves rate", async () => {
    const weeks: WeekCountersMap = { [WEEK]: emptyWeek() };
    weeks[WEEK].searches = 6_000;
    const res = weeklyResponse(
      { weeks, source: "local", kvReadFailed: false },
      {},
      8,
      {},
      {}, // REEA-1237 query-term Pareto map (5th arg)
      { [WEEK]: 12 }, // REEA-1255 share clicks (6th arg)
    );
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      methodology: Record<string, string>;
    };
    const w = body.weeks[WEEK];
    expect(w.share_whatsapp).toBe(12);
    expect(w.share_whatsapp_per_1k_serves).toBe(2);
    // AC5(b) — named in methodology, with the null-when-no-basis rule.
    expect(body.methodology.share_whatsapp).toContain("share_whatsapp");
    expect(body.methodology.share_whatsapp).toContain("per_1k");
    expect(body.methodology.share_whatsapp).toContain("null");
    expect(body.methodology.share_whatsapp).toContain("per-user identifier");
  });

  it("reads 0/null when the week has no shares or no serve basis", async () => {
    const res = weeklyResponse(
      { weeks: { [WEEK]: emptyWeek() }, source: "local", kvReadFailed: false },
      {},
      8,
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, unknown>> };
    const w = body.weeks[WEEK];
    expect(w.share_whatsapp).toBe(0);
    expect(w.share_whatsapp_per_1k_serves).toBeNull();
  });
});
