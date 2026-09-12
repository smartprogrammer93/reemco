/**
 * REEA-807 — weekly outcome counter tests.
 *
 * Pins the aggregate contract: weekly bucket math (ISO week keys, retention),
 * the search-outcome and link-smoke folds, the snapshot→outcome mapper, and
 * the store round-trip under both layers (injected fake KV / local file).
 * The no-PII constraint is enforced structurally: the persisted blob must
 * carry ONLY the known counter fields — any extra key fails these tests.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLinkSmoke,
  applySearchOutcome,
  isoWeekKey,
  MAX_RETAILERS_PER_WEEK,
  METRICS_KV_KEY,
  pruneWeeks,
  readWeeklyCounters,
  recordLinkSmoke,
  recordSearchOutcome,
  searchOutcomeFromSnapshot,
  RETENTION_WEEKS,
  updateWeeklyCounters,
  type WeekCountersMap,
} from "@/lib/metrics";
import type { SharedKv } from "@/lib/collect/kv";

function tmpDir(): string {
  return join(process.cwd(), ".metrics-tests", Math.random().toString(36).slice(2));
}

function cleanDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
}

/** Fake KV: records every write so tests can assert the persisted schema. */
function fakeKv(): SharedKv & { writes: { key: string; value: string; ttl: number }[] } {
  const store = new Map<string, string>();
  const writes: { key: string; value: string; ttl: number }[] = [];
  return {
    writes,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, ttlSeconds) {
      writes.push({ key, value, ttl: ttlSeconds });
      store.set(key, value);
      return true;
    },
  };
}

describe("REEA-807 isoWeekKey", () => {
  it("buckets by ISO week across month and year boundaries", () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeekKey(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    // 2025-12-31 belongs to ISO week 1 of 2026 (Thursday of that week).
    expect(isoWeekKey(Date.UTC(2025, 11, 31))).toBe("2026-W01");
    // 2026-09-12 (Saturday) sits in the week of Mon 2026-09-07 → W37.
    expect(isoWeekKey(Date.UTC(2026, 8, 12))).toBe("2026-W37");
    // The Monday of that same week shares the bucket.
    expect(isoWeekKey(Date.UTC(2026, 8, 7))).toBe("2026-W37");
  });
});

describe("REEA-807 applySearchOutcome", () => {
  it("counts the search, the zero-offer flag, and per-retailer offers", () => {
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 3, Jarir: 2 },
    });
    applySearchOutcome(weeks, "2026-W37", { zeroOffers: true, offersByRetailer: {} });
    const w = weeks["2026-W37"];
    expect(w.searches).toBe(2);
    expect(w.zero_offer_searches).toBe(1);
    expect(w.offers_by_retailer).toEqual({ Xcite: 3, Jarir: 2 });
  });

  it("accumulates across searches and sanitizes merchant names", () => {
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 2 },
    });
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 1, "Bad\u0000Name": 4 },
    });
    const w = weeks["2026-W37"];
    expect(w.offers_by_retailer["Xcite"]).toBe(3);
    expect(w.offers_by_retailer["BadName"]).toBe(4);
  });

  it("folds overflow retailers into 'other' at the weekly cap", () => {
    const weeks: WeekCountersMap = {};
    for (let i = 0; i < MAX_RETAILERS_PER_WEEK + 3; i++) {
      applySearchOutcome(weeks, "2026-W37", {
        zeroOffers: false,
        offersByRetailer: { [`Retailer ${i}`]: 1 },
      });
    }
    const w = weeks["2026-W37"];
    // 48 named retailers plus the overflow bucket itself.
    expect(Object.keys(w.offers_by_retailer)).toHaveLength(MAX_RETAILERS_PER_WEEK + 1);
    expect(w.offers_by_retailer["other"]).toBe(3);
  });
});

describe("REEA-807 applyLinkSmoke", () => {
  it("totals runs/checked/dead and merges per-retailer counts", () => {
    const weeks: WeekCountersMap = {};
    applyLinkSmoke(weeks, "2026-W37", {
      checked: 10,
      dead: 1,
      byRetailer: { Xcite: { checked: 6, dead: 1 }, Jarir: { checked: 4, dead: 0 } },
    });
    applyLinkSmoke(weeks, "2026-W37", {
      checked: 5,
      dead: 0,
      byRetailer: { Xcite: { checked: 5, dead: 0 } },
    });
    const s = weeks["2026-W37"].link_smoke;
    expect(s.runs).toBe(2);
    expect(s.checked).toBe(15);
    expect(s.dead).toBe(1);
    expect(s.by_retailer["Xcite"]).toEqual({ checked: 11, dead: 1 });
    expect(s.by_retailer["Jarir"]).toEqual({ checked: 4, dead: 0 });
  });

  it("clamps dead > checked instead of recording impossible math", () => {
    const weeks: WeekCountersMap = {};
    applyLinkSmoke(weeks, "2026-W37", {
      checked: 3,
      dead: 99,
      byRetailer: { Xcite: { checked: 2, dead: 7 } },
    });
    const s = weeks["2026-W37"].link_smoke;
    expect(s.dead).toBe(3);
    expect(s.by_retailer["Xcite"].dead).toBe(2);
  });
});

describe("REEA-807 searchOutcomeFromSnapshot", () => {
  it("keeps only successful notes and reads zero-offer from the product count", () => {
    const snap = {
      products: [{}, {}],
      notes: [
        { merchant: "Xcite", hits: 4 },
        { merchant: "Sultan Center", hits: 0 },
        { merchant: "Jarir", hits: 9, error: "timeout" },
      ],
    };
    expect(searchOutcomeFromSnapshot(snap)).toEqual({
      zeroOffers: false,
      offersByRetailer: { Xcite: 4 },
    });
    expect(searchOutcomeFromSnapshot({ products: [], notes: [] }).zeroOffers).toBe(true);
  });
});

describe("REEA-807 pruneWeeks", () => {
  it("keeps the trailing retention window in ISO order", () => {
    const weeks: WeekCountersMap = {};
    for (let i = 0; i < RETENTION_WEEKS + 4; i++) {
      const d = new Date(Date.UTC(2026, 8, 12) - i * 7 * 24 * 60 * 60 * 1000);
      weeks[isoWeekKey(d.getTime())] = {
        searches: i,
        zero_offer_searches: 0,
        offers_by_retailer: {},
        link_smoke: { runs: 0, checked: 0, dead: 0, by_retailer: {} },
      };
    }
    const pruned = pruneWeeks(weeks);
    expect(Object.keys(pruned)).toHaveLength(RETENTION_WEEKS);
    // The oldest buckets dropped, the newest kept, ascending order intact.
    const keys = Object.keys(pruned);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("REEA-807 store round-trip", () => {
  it("records and reads back through the local file layer", async () => {
    const dir = tmpDir();
    try {
      await recordSearchOutcome(
        { zeroOffers: false, offersByRetailer: { Xcite: 2 } },
        { dir, now: Date.UTC(2026, 8, 12) },
      );
      await recordSearchOutcome(
        { zeroOffers: true, offersByRetailer: {} },
        { dir, now: Date.UTC(2026, 8, 12) },
      );
      const weeks = await readWeeklyCounters({ dir });
      expect(weeks["2026-W37"].searches).toBe(2);
      expect(weeks["2026-W37"].zero_offer_searches).toBe(1);
      expect(weeks["2026-W37"].offers_by_retailer).toEqual({ Xcite: 2 });
    } finally {
      cleanDir(dir);
    }
  });

  it("persisted schema carries counters and retailer names only (no PII)", async () => {
    const kv = fakeKv();
    await recordLinkSmoke(
      { checked: 7, dead: 1, byRetailer: { Xcite: { checked: 7, dead: 1 } } },
      { kv, now: Date.UTC(2026, 8, 12) },
    );
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0].key).toBe(METRICS_KV_KEY);
    const blob = JSON.parse(kv.writes[0].value) as { weeks: Record<string, Record<string, unknown>> };
    const week = blob.weeks["2026-W37"];
    expect(Object.keys(week).sort()).toEqual([
      "link_smoke",
      "offers_by_retailer",
      "searches",
      "zero_offer_searches",
    ]);
    expect(Object.keys(week.link_smoke as object).sort()).toEqual([
      "by_retailer",
      "checked",
      "dead",
      "runs",
    ]);
    // Retailer names only — no URL, no query, no identifier fields anywhere.
    expect(kv.writes[0].value).not.toMatch(/https?:\/\//);
  });

  it("degrades to the local layer when the shared write fails, without double counting", async () => {
    const dir = tmpDir();
    const kv: SharedKv = {
      async get() {
        return null;
      },
      async set() {
        return false; // shared write unreachable
      },
    };
    try {
      await recordSearchOutcome(
        { zeroOffers: false, offersByRetailer: { Jarir: 1 } },
        { dir, kv, now: Date.UTC(2026, 8, 12) },
      );
      const weeks = await readWeeklyCounters({ dir });
      expect(weeks["2026-W37"].searches).toBe(1);
      expect(weeks["2026-W37"].offers_by_retailer).toEqual({ Jarir: 1 });
    } finally {
      cleanDir(dir);
    }
  });

  it("KV-bound stores count once — a second write merges into the shared blob", async () => {
    const kv = fakeKv();
    const dir = tmpDir();
    const apply = (n: number) =>
      updateWeeklyCounters(
        (weeks, week) => applySearchOutcome(weeks, week, { zeroOffers: false, offersByRetailer: { Xcite: n } }),
        { kv, dir, now: Date.UTC(2026, 8, 12) },
      );
    try {
      await apply(2);
      await apply(3);
      const weeks = await readWeeklyCounters({ kv, dir });
      expect(weeks["2026-W37"].searches).toBe(2);
      expect(weeks["2026-W37"].offers_by_retailer["Xcite"]).toBe(5);
      expect(kv.writes).toHaveLength(2); // one write per record, never a re-mirror
    } finally {
      cleanDir(dir);
    }
  });
});
