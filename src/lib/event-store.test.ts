import { describe, expect, it } from "vitest";
import { appendEvents, pruneOldEvents, readEvents, MAX_AGE_DAYS } from "@/lib/event-store";
import { aggregateWeekly } from "@/lib/report";
import { checkRateLimit, resetRateLimiter } from "@/lib/rate-limit";

const day = 24 * 60 * 60 * 1000;

describe("event store + retention", () => {
  it("appends events with random id and server ts, and reads them back", () => {
    const dir = `.events-test-${Math.random().toString(36).slice(2)}`;
    const [e] = appendEvents([{ type: "zero_results", query: "q1" }], { dir });
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
    expect(new Date(e.ts).getTime()).toBeGreaterThan(0);
    const all = readEvents(dir);
    expect(all).toHaveLength(1);
    expect(all[0].query).toBe("q1");
  });

  it("prunes raw events older than the 90-day retention window", () => {
    const dir = `.events-test-${Math.random().toString(36).slice(2)}`;
    const now = Date.parse("2026-09-05T00:00:00Z");
    appendEvents([{ type: "zero_results", query: "old" }], { dir, now: now - (MAX_AGE_DAYS + 1) * day });
    appendEvents([{ type: "zero_results", query: "new" }], { dir, now: now - day });
    expect(readEvents(dir)).toHaveLength(2);
    const pruned = pruneOldEvents({ now, dir });
    expect(pruned).toBe(1);
    const kept = readEvents(dir);
    expect(kept).toHaveLength(1);
    expect(kept[0].query).toBe("new");
  });
});

describe("weekly report aggregation (AC-4)", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const ev = (
    ts: string,
    type: string,
    extra: Record<string, unknown> = {},
  ): Parameters<typeof aggregateWeekly>[0][number] =>
    ({ id: "x", ts, type, query: "q", ...extra }) as never;

  it("computes click-out rate, zero-result rate and top queries", () => {
    const events = [
      ev("2026-09-05T01:00:00Z", "search_submitted", { query: "iphone", result_count: 5 }),
      ev("2026-09-05T01:01:00Z", "item_clicked", { query: "iphone", rank: 0, item_id: "p1" }),
      ev("2026-09-04T01:00:00Z", "search_submitted", { query: "pixel", result_count: 0 }),
      ev("2026-09-04T01:00:30Z", "zero_results", { query: "pixel" }),
      ev("2026-09-04T02:00:00Z", "search_submitted", { query: "iphone", result_count: 3 }),
      ev("2026-08-01T00:00:00Z", "search_submitted", { query: "ancient", result_count: 1 }), // outside window
    ];
    const report = aggregateWeekly(events, { now, windowDays: 7 });
    expect(report.searches).toBe(3);
    expect(report.click_outs).toBe(1);
    expect(report.click_out_rate).toBeCloseTo(1 / 3);
    expect(report.zero_results).toBe(1);
    expect(report.zero_result_rate).toBeCloseTo(1 / 3);
    expect(report.top_queries[0]).toEqual({ query: "iphone", count: 2 });
  });

  it("returns null rates when there were no searches", () => {
    const report = aggregateWeekly([], { now });
    expect(report.searches).toBe(0);
    expect(report.click_out_rate).toBeNull();
    expect(report.zero_result_rate).toBeNull();
  });
});

describe("ingestion rate limiter (AC-6)", () => {
  it("allows up to the limit then blocks within the window", () => {
    const store = new Map<string, number[]>();
    resetRateLimiter(store);
    const opts = { limit: 3, windowMs: 1000 };
    expect(checkRateLimit("ip1", 0, opts, store).allowed).toBe(true);
    expect(checkRateLimit("ip1", 1, opts, store).allowed).toBe(true);
    expect(checkRateLimit("ip1", 2, opts, store).allowed).toBe(true);
    expect(checkRateLimit("ip1", 2, opts, store).allowed).toBe(false);
    // other callers unaffected
    expect(checkRateLimit("ip2", 3, opts, store).allowed).toBe(true);
    // window slides
    expect(checkRateLimit("ip1", 1500, opts, store).allowed).toBe(true);
  });
});
