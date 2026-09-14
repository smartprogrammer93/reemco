import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvents, EVENTS_DIR, pruneOldEvents, readEvents, MAX_AGE_DAYS } from "@/lib/event-store";
import { aggregateWeekly } from "@/lib/report";
import type { SharedKv } from "@/lib/collect/kv";
import { checkRateLimit, resetRateLimiter } from "@/lib/rate-limit";

const day = 24 * 60 * 60 * 1000;

function tmpDir(): string {
  return join(EVENTS_DIR ? `${EVENTS_DIR}-tests` : ".events-test", Math.random().toString(36).slice(2));
}

function cleanDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
}

/** In-memory stand-in for the Upstash binding (REEA-233 cross-instance layer). */
function fakeKv(): SharedKv {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return true;
    },
  };
}

describe("event store + retention", () => {
  it("appends events with random id and server ts, and reads them back", async () => {
    const dir = tmpDir();
    const [e] = await appendEvents([{ type: "zero_results", query: "q1" }], { dir });
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
    expect(new Date(e.ts).getTime()).toBeGreaterThan(0);
    const all = await readEvents({ dir });
    expect(all).toHaveLength(1);
    expect(all[0].query).toBe("q1");
    cleanDir(dir);
  });

  it("prunes raw events older than the 90-day retention window", async () => {
    const dir = tmpDir();
    const now = Date.parse("2026-09-05T00:00:00Z");
    await appendEvents([{ type: "zero_results", query: "old" }], { dir, now: now - (MAX_AGE_DAYS + 1) * day });
    await appendEvents([{ type: "zero_results", query: "new" }], { dir, now: now - day });
    expect(await readEvents({ dir })).toHaveLength(2);
    const pruned = await pruneOldEvents({ now, dir });
    expect(pruned).toBe(1);
    const kept = await readEvents({ dir });
    expect(kept).toHaveLength(1);
    expect(kept[0].query).toBe("new");
    cleanDir(dir);
  });
});

describe("cross-instance durability (REEA-233)", () => {
  it("accumulates scheduled runs across instances through the shared layer", async () => {
    const kv = fakeKv();
    const dirA = tmpDir();
    const dirB = tmpDir();

    // Instance A handled two smoke runs, instance B one. Disk-only, B would
    // report just its own single event; through KV it sees all three.
    await appendEvents([{ type: "search_submitted", query: "sony", result_count: 3 }], { dir: dirA, kv });
    await appendEvents([{ type: "search_submitted", query: "sony", result_count: 3 }], { dir: dirA, kv });
    await appendEvents([{ type: "search_submitted", query: "canon", result_count: 1 }], { dir: dirB, kv });

    const onB = await readEvents({ dir: dirB, kv });
    expect(onB).toHaveLength(3); // 1 local + 2 mirrored from instance A
    const onA = await readEvents({ dir: dirA, kv });
    expect(onA).toHaveLength(3);

    // A cold instance with nothing on its own disk still gets the full window.
    const cold = await readEvents({ dir: tmpDir(), kv });
    expect(cold).toHaveLength(3);
    cleanDir(dirA);
    cleanDir(dirB);
  });

  it("counts an event mirrored to KV and still on local disk exactly once", async () => {
    const kv = fakeKv();
    const dir = tmpDir();
    await appendEvents([{ type: "item_clicked", query: "q", rank: 0, item_id: "p", outbound_url: "https://x.example/a" }], { dir, kv });
    await appendEvents([{ type: "item_clicked", query: "q", rank: 1, item_id: "p", outbound_url: "https://x.example/b" }], { dir, kv });
    const all = await readEvents({ dir, kv });
    expect(all).toHaveLength(2);
    cleanDir(dir);
  });

  it("prunes expired lines out of the shared blob too", async () => {
    const kv = fakeKv();
    const dir = tmpDir();
    const empty = tmpDir();
    const now = Date.parse("2026-09-05T00:00:00Z");
    await appendEvents([{ type: "zero_results", query: "old-shared" }], { dir, now: now - (MAX_AGE_DAYS + 1) * day, kv });
    const pruned = await pruneOldEvents({ now, dir, kv });
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await readEvents({ dir: empty, kv })).toHaveLength(0);
    cleanDir(dir);
  });

  it("stays purely local when no KV binding is configured", async () => {
    const dir = tmpDir();
    await appendEvents([{ type: "zero_results", query: "local-only" }], { dir, kv: null });
    expect(await readEvents({ dir, kv: null })).toHaveLength(1);
    cleanDir(dir);
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

  it("computes click-out rate, copy-rate beside it, zero-result rate and top queries", () => {
    const events = [
      ev("2026-09-05T01:00:00Z", "search_submitted", { query: "iphone", result_count: 5 }),
      ev("2026-09-05T01:01:00Z", "item_clicked", { query: "iphone", rank: 0, item_id: "p1" }),
      ev("2026-09-05T01:01:30Z", "summary_copied", { query: "iphone", item_id: "p1" }),
      ev("2026-09-04T01:00:00Z", "search_submitted", { query: "pixel", result_count: 0 }),
      ev("2026-09-04T01:00:30Z", "zero_results", { query: "pixel" }),
      ev("2026-09-04T02:00:00Z", "search_submitted", { query: "iphone", result_count: 3 }),
      ev("2026-08-01T00:00:00Z", "search_submitted", { query: "ancient", result_count: 1 }), // outside window
    ];
    const report = aggregateWeekly(events, { now, windowDays: 7 });
    expect(report.searches).toBe(3);
    expect(report.click_outs).toBe(1);
    expect(report.click_out_rate).toBeCloseTo(1 / 3);
    expect(report.copies).toBe(1);
    expect(report.copy_rate).toBeCloseTo(1 / 3);
    expect(report.zero_results).toBe(1);
    expect(report.zero_result_rate).toBeCloseTo(1 / 3);
    expect(report.top_queries[0]).toEqual({ query: "iphone", count: 2 });
  });

  it("returns null rates when there were no searches", () => {
    const report = aggregateWeekly([], { now });
    expect(report.searches).toBe(0);
    expect(report.click_out_rate).toBeNull();
    expect(report.copy_rate).toBeNull();
    expect(report.zero_result_rate).toBeNull();
    expect(report.click_rank_histogram).toEqual([]);
  });

  it("buckets item_clicked events by card rank, ascending, reconciling with click_outs", () => {
    const events = [
      ev("2026-09-05T01:00:00Z", "item_clicked", { rank: 0, item_id: "a" }),
      ev("2026-09-05T01:00:01Z", "item_clicked", { rank: 0, item_id: "b" }),
      ev("2026-09-05T01:00:02Z", "item_clicked", { rank: 2, item_id: "c" }),
      ev("2026-09-05T01:00:03Z", "item_clicked", { rank: -1, item_id: "d" }), // product-detail clicks
      ev("2026-09-05T01:00:04Z", "result_impressed", { rank: 5, item_id: "e" }), // not a click
      ev("2026-08-01T00:00:00Z", "item_clicked", { rank: 7, item_id: "f" }), // outside window
    ];
    const report = aggregateWeekly(events, { now, windowDays: 7 });
    expect(report.click_outs).toBe(4);
    expect(report.click_rank_histogram).toEqual([
      { rank: -1, count: 1 },
      { rank: 0, count: 2 },
      { rank: 2, count: 1 },
    ]);
    // Position-1 share and mean clicked position derive straight from it.
    const total = report.click_rank_histogram.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(report.click_outs);
    const firstShare =
      (report.click_rank_histogram.find((b) => b.rank === 0)?.count ?? 0) / total;
    expect(firstShare).toBeCloseTo(0.5);
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

// REEA-965 — v1 metrics aggregation (R2 spec AC-6/AC-7): zero-result rate and
// first-result CTR per day, coupon-hit rate per retailer — all computed from
// the raw event stream alone (FR-3.3/FR-3.4).
describe("v1 metrics aggregation (REEA-965 AC-6/AC-7)", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const ev = (
    ts: string,
    type: string,
    extra: Record<string, unknown> = {},
  ): Parameters<typeof aggregateWeekly>[0][number] =>
    ({ id: "x", ts, type, ...extra }) as never;

  it("computes zero-result rate and first-result CTR over the window", () => {
    const events = [
      ev("2026-09-05T01:00:00Z", "search_performed", { queryId: "q1", query: "iphone", resultCount: 5, relatedCount: 2 }),
      ev("2026-09-05T01:00:10Z", "first_result_click", { queryId: "q1", offerId: "p1", retailer: "Xcite", position: 1 }),
      ev("2026-09-05T02:00:00Z", "search_performed", { queryId: "q2", query: "zzqqxx", resultCount: 0, relatedCount: 0 }),
      ev("2026-09-05T02:00:10Z", "zero_result_shown", { queryId: "q2", query: "zzqqxx", relatedCount: 0 }),
      // A search with zero results does NOT join the first-result CTR denominator.
      ev("2026-09-04T01:00:00Z", "search_performed", { queryId: "q3", query: "kindle", resultCount: 0, relatedCount: 4 }),
      ev("2026-09-04T02:00:00Z", "search_performed", { queryId: "q4", query: "dyson", resultCount: 2, relatedCount: 0 }),
      ev("2026-08-01T00:00:00Z", "search_performed", { queryId: "q0", query: "old", resultCount: 1, relatedCount: 0 }), // outside window
    ];
    const report = aggregateWeekly(events, { now, windowDays: 7 });
    expect(report.v1.searches).toBe(4);
    expect(report.v1.zero_result_shown).toBe(1);
    expect(report.v1.first_result_clicks).toBe(1);
    expect(report.v1.zero_result_rate).toBeCloseTo(1 / 4);
    // Denominator: searches with resultCount >= 1 only (2 of 4).
    expect(report.v1.first_result_ctr).toBeCloseTo(1 / 2);
    expect(report.v1.result_clicks).toBe(0);
    expect(report.v1.related_clicks).toBe(0);
  });

  it("breaks the rates down per UTC day (AC-6 queryability)", () => {
    const events = [
      ev("2026-09-05T01:00:00Z", "search_performed", { queryId: "a", query: "x", resultCount: 1, relatedCount: 0 }),
      ev("2026-09-05T02:00:00Z", "zero_result_shown", { queryId: "b", query: "y", relatedCount: 0 }),
      ev("2026-09-04T23:00:00Z", "search_performed", { queryId: "c", query: "z", resultCount: 1, relatedCount: 0 }),
      ev("2026-09-04T23:10:00Z", "first_result_click", { queryId: "c", offerId: "p", retailer: "Jarir", position: 1 }),
    ];
    const report = aggregateWeekly(events, { now, windowDays: 7 });
    expect(report.v1.per_day).toEqual([
      {
        day: "2026-09-04",
        searches: 1,
        zero_result_shown: 0,
        first_result_clicks: 1,
        zero_result_rate: 0, // 1 search, no zero renders — a real 0, not null
        first_result_ctr: 1,
      },
      {
        day: "2026-09-05",
        searches: 1,
        zero_result_shown: 1,
        first_result_clicks: 0,
        zero_result_rate: 1,
        first_result_ctr: 0, // 1 search carried results, no first click yet
      },
    ]);
  });

  it("computes coupon-hit rate per retailer from offer_rendered / coupon_hit (AC-7)", () => {
    const qid = { queryId: "q1" };
    const events = [
      ev("2026-09-05T01:00:00Z", "offer_rendered", { ...qid, retailer: "Xcite", hasCoupon: true, priceSanityStatus: null }),
      ev("2026-09-05T01:00:01Z", "coupon_hit", { ...qid, retailer: "Xcite", offerId: "p1" }),
      ev("2026-09-05T01:00:02Z", "offer_rendered", { ...qid, retailer: "Xcite", hasCoupon: false, priceSanityStatus: null }),
      ev("2026-09-05T01:00:03Z", "offer_rendered", { ...qid, retailer: "Jarir", hasCoupon: true, priceSanityStatus: null }),
      ev("2026-09-05T01:00:04Z", "coupon_hit", { ...qid, retailer: "Jarir", offerId: "p2" }),
      ev("2026-09-05T01:00:05Z", "coupon_hit", { ...qid, retailer: "Jarir", offerId: "p3" }),
    ];
    const report = aggregateWeekly(events, { now, windowDays: 7 });
    expect(report.v1.coupon_hit_rate_by_retailer).toEqual([
      // Higher rendered volume first; ties break alphabetically.
      { retailer: "Xcite", offers_rendered: 2, coupon_hits: 1, coupon_hit_rate: 0.5 },
      { retailer: "Jarir", offers_rendered: 1, coupon_hits: 2, coupon_hit_rate: 2 },
    ]);
  });

  it("returns null rates and empty structures when no v1 events exist", () => {
    const report = aggregateWeekly(
      [ev("2026-09-05T01:00:00Z", "search_submitted", { query: "q", result_count: 1 })],
      { now },
    );
    expect(report.v1.searches).toBe(0);
    expect(report.v1.zero_result_rate).toBeNull();
    expect(report.v1.first_result_ctr).toBeNull();
    expect(report.v1.per_day).toEqual([]);
    expect(report.v1.coupon_hit_rate_by_retailer).toEqual([]);
  });
});
