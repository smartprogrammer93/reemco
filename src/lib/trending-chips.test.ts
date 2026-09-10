/**
 * REEA-542 Bet C — trending homepage chips.
 *
 * Coverage for the three acceptance criteria: anchor-first ranking over the
 * last-24h event feed (AC1 tally conventions), hourly cache stability + the
 * health-tick invalidation hook (AC2), and the curated fallback below three
 * eligible queries / on a dead feed (AC3).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvents, EVENTS_DIR, readEvents } from "@/lib/event-store";
import type { FunnelEvent } from "@/lib/events";
import {
  getTrendingChips,
  invalidateTrendingChips,
  selectTrendingChips,
} from "@/lib/trending-chips";

const CURATED = ["Top Pick", "second curated", "third curated"];

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

/** search_submitted events with an explicit timestamp. */
function searches(query: string, count: number, tsMs: number, offset = 0): FunnelEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s-${query}-${offset}-${i}`,
    ts: new Date(tsMs).toISOString(),
    type: "search_submitted" as const,
    query,
    result_count: 1,
  }));
}

const HOUR = 60 * 60 * 1000;

describe("selectTrendingChips — ranking (AC1)", () => {
  it("keeps position 1 curated and fills the rest by last-24h top queries", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const fresh = now - HOUR;
    const events = [
      ...searches("air fryer", 5, fresh),
      ...searches("iphone 15", 4, fresh),
      ...searches("desk lamp", 3, fresh),
      ...searches("ramadan dates", 2, fresh),
      // outside the 24h window despite a huge count — must not rank:
      ...searches("coffee beans", 9, now - 25 * HOUR),
    ];
    const chips = selectTrendingChips(events, CURATED, { now });
    expect(chips.map((c) => c.query)).toEqual(["Top Pick", "air fryer", "iphone 15"]);
  });

  it("drops queries identical to the anchor and folds case variants", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const t = now - HOUR;
    const events = [
      ...searches("Sony TV", 9, t), // collides with the anchor — excluded
      ...searches("air fryer", 4, t),
      ...searches("desk lamp", 3, t),
      ...searches("led bulb", 2, t),
      ...searches("Air Fryer", 1, t), // case-fold onto "air fryer"
    ];
    const chips = selectTrendingChips(events, ["sony tv", "b", "c"], { now });
    expect(chips.map((c) => c.query)).toEqual(["sony tv", "air fryer", "desk lamp"]);
  });

  it("counts search submissions only, not clicks (weekly-report convention)", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const t = now - HOUR;
    const clicks: FunnelEvent[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c-${i}`,
      ts: new Date(t).toISOString(),
      type: "item_clicked" as const,
      query: "alpha",
      rank: 0,
      item_id: "x",
    }));
    const events = [
      ...searches("beta", 4, t),
      ...searches("alpha", 3, t),
      ...clicks, // alpha reaches 8 only if clicks counted — they must not
      ...searches("gamma", 1, t),
    ];
    const chips = selectTrendingChips(events, CURATED, { now });
    expect(chips.map((c) => c.query)).toEqual(["Top Pick", "beta", "alpha"]);
  });

  it("caps the pill label but keeps the full query on the chip", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const t = now - HOUR;
    const long = "wireless noise cancelling headphones for airplane cabin travel with a usb c charger";
    const events = [
      ...searches(long, 6, t),
      ...searches("mids", 3, t),
      ...searches("tail", 1, t),
    ];
    const chips = selectTrendingChips(events, CURATED, { now });
    expect(chips[1].query).toBe(long); // href/pre-warm carry the full string
    expect(chips[1].label.length).toBeLessThanOrEqual(65);
    expect(chips[1].label.endsWith("…")).toBe(true);
    expect(long.startsWith(chips[1].label.slice(0, 20))).toBe(true);
  });

  it("falls back to the curated set below three eligible queries (AC3)", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const t = now - HOUR;
    const events = [...searches("air fryer", 7, t), ...searches("desk lamp", 5, t)];
    const chips = selectTrendingChips(events, CURATED, { now });
    expect(chips.map((c) => c.query)).toEqual(CURATED);
  });

  it("uses the trending set at exactly three eligible queries", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const t = now - HOUR;
    const events = [
      ...searches("air fryer", 3, t),
      ...searches("desk lamp", 2, t),
      ...searches("led bulb", 1, t),
    ];
    const chips = selectTrendingChips(events, CURATED, { now });
    expect(chips.map((c) => c.query)).toEqual(["Top Pick", "air fryer", "desk lamp"]);
  });
});

describe("getTrendingChips — hourly bake + health-tick hook (AC2)", () => {
  it("serves the same baked set inside the hour and re-bakes past it", async () => {
    invalidateTrendingChips();
    const dir = tmpDir();
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    await appendEvents(
      [
        ...searches("a a", 3, now - HOUR),
        ...searches("b b", 2, now - HOUR),
        ...searches("c c", 1, now - HOUR),
      ].map(({ query, type, result_count }) => ({ type, query, result_count })),
      { dir, kv: null, now: now - HOUR },
    );
    const first = await getTrendingChips(CURATED, { now, dir, kv: null });
    expect(first.map((c) => c.query)).toEqual(["Top Pick", "a a", "b b"]);

    // New volume 30 minutes later must NOT change the row within the hour…
    await appendEvents(
      [...searches("d d", 9, now), ...searches("e e", 9, now)].map(
        ({ query, type, result_count }) => ({ type, query, result_count }),
      ),
      { dir, kv: null, now: now + 30 * 60 * 1000 },
    );
    const second = await getTrendingChips(CURATED, { now: now + 35 * 60 * 1000, dir, kv: null });
    expect(second.map((c) => c.query)).toEqual(["Top Pick", "a a", "b b"]);

    // …but past the hour the row re-bakes onto the newer leaders.
    const third = await getTrendingChips(CURATED, { now: now + 61 * 60 * 1000, dir, kv: null });
    expect(third.map((c) => c.query)).toEqual(["Top Pick", "d d", "e e"]);
    cleanDir(dir);
  });

  it("invalidateTrendingChips re-bakes immediately (hourly cron tick)", async () => {
    invalidateTrendingChips();
    const dir = tmpDir();
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    await appendEvents(
      [
        ...searches("old top", 3, now),
        ...searches("old filler", 2, now),
        ...searches("old filler2", 1, now),
      ].map(({ query, type, result_count }) => ({ type, query, result_count })),
      { dir, kv: null, now },
    );
    const first = await getTrendingChips(CURATED, { now, dir, kv: null });
    expect(first[1].query).toBe("old top");

    await appendEvents(
      searches("new top", 5, now + 5 * 60 * 1000).map(
        ({ query, type, result_count }) => ({ type, query, result_count }),
      ),
      { dir, kv: null, now: now + 5 * 60 * 1000 },
    );
    invalidateTrendingChips(); // what /api/health does on its hourly tick
    const after = await getTrendingChips(CURATED, { now: now + 10 * 60 * 1000, dir, kv: null });
    expect(after[1].query).toBe("new top");
    cleanDir(dir);
  });

  it("falls back to the curated set when the feed is empty or unreadable (AC3)", async () => {
    invalidateTrendingChips();
    const dir = tmpDir();
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const empty = await getTrendingChips(CURATED, { now, dir, kv: null });
    expect(empty.map((c) => c.query)).toEqual(CURATED);
    // the fallback itself is baked for the hour, and a dead dir never throws
    const cached = await getTrendingChips(CURATED, { now: now + 1000, dir, kv: null });
    expect(cached.map((c) => c.query)).toEqual(CURATED);
    const dead = await getTrendingChips(CURATED, { now: now + 61 * 60 * 1000, dir: join(dir, "missing"), kv: null });
    expect(dead.map((c) => c.query)).toEqual(CURATED);
    expect(await readEvents({ dir, kv: null })).toHaveLength(0);
    cleanDir(dir);
  });
});
