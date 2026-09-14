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
  emptyWeek,
  isoWeekKey,
  latencyBandOf,
  MAX_RETAILERS_PER_WEEK,
  METRICS_KV_KEY,
  pruneWeeks,
  readWeeklyCounters,
  recordLinkSmoke,
  recordSearchOutcome,
  searchOutcomeFromSnapshot,
  serveOutcomeOf,
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
      serveOutcome: "full",
      serveLatencyMs: 1200,
    });
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: true,
      offersByRetailer: {},
      serveOutcome: "pending",
      serveLatencyMs: 900,
    });
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
      serveOutcome: "full",
      serveLatencyMs: 900,
    });
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 1, "Bad\u0000Name": 4 },
      serveOutcome: "full",
      serveLatencyMs: 900,
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
        serveOutcome: "full",
        serveLatencyMs: 900,
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
        ...emptyWeek(),
        searches: i,
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
        { zeroOffers: false, offersByRetailer: { Xcite: 2 }, serveOutcome: "full", serveLatencyMs: 900 },
        { dir, now: Date.UTC(2026, 8, 12) },
      );
      await recordSearchOutcome(
        { zeroOffers: true, offersByRetailer: {}, serveOutcome: "pending", serveLatencyMs: 900 },
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
      "cold_serves_full",
      "cold_serves_pending",
      "latency_band_1_3s",
      "latency_band_3_10s",
      "latency_band_gt_10s",
      "latency_band_lt_1s",
      "link_smoke",
      "offers_by_retailer",
      "retailer_adapter_attempts",
      "retailer_adapter_failures",
      "searches",
      "zero_offer_searches",
    ]);
    // REEA-871 — the extension maps carry retailer names only, same keys as
    // the per-retailer offer counts.
    expect(Object.keys(week.retailer_adapter_attempts as object)).toEqual([]);
    expect(Object.keys(week.retailer_adapter_failures as object)).toEqual([]);
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
        { zeroOffers: false, offersByRetailer: { Jarir: 1 }, serveOutcome: "full", serveLatencyMs: 900 },
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
        (weeks, week) =>
          applySearchOutcome(weeks, week, {
            zeroOffers: false,
            offersByRetailer: { Xcite: n },
            serveOutcome: "full",
            serveLatencyMs: 900,
          }),
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

describe("REEA-871 cold-serve outcome + latency bands", () => {
  it("splits exactly one cold-serve bucket per search, so full + pending == searches", () => {
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 2 },
      serveOutcome: "full",
      serveLatencyMs: 900,
    });
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: {},
      serveOutcome: "pending",
      serveLatencyMs: 4_000,
    });
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: true,
      offersByRetailer: {},
      serveOutcome: "pending",
      serveLatencyMs: 11_000,
    });
    const w = weeks["2026-W37"];
    expect(w.searches).toBe(3);
    expect(w.cold_serves_full).toBe(1);
    expect(w.cold_serves_pending).toBe(2);
    expect(w.cold_serves_full + w.cold_serves_pending).toBe(w.searches);
  });

  it("bands each serve latency into exactly one bucket (edges inclusive as documented)", () => {
    expect(latencyBandOf(-5)).toBe("latency_band_lt_1s");
    expect(latencyBandOf(0)).toBe("latency_band_lt_1s");
    expect(latencyBandOf(999)).toBe("latency_band_lt_1s");
    expect(latencyBandOf(1_000)).toBe("latency_band_1_3s");
    expect(latencyBandOf(2_999)).toBe("latency_band_1_3s");
    expect(latencyBandOf(3_000)).toBe("latency_band_3_10s");
    expect(latencyBandOf(10_000)).toBe("latency_band_3_10s");
    expect(latencyBandOf(10_001)).toBe("latency_band_gt_10s");
    expect(latencyBandOf(Number.NaN)).toBe("latency_band_lt_1s");

    const weeks: WeekCountersMap = {};
    const latencies = [500, 1_500, 1_500, 4_000, 12_000];
    for (const ms of latencies) {
      applySearchOutcome(weeks, "2026-W37", {
        zeroOffers: false,
        offersByRetailer: {},
        serveOutcome: "full",
        serveLatencyMs: ms,
      });
    }
    const w = weeks["2026-W37"];
    expect(w.latency_band_lt_1s).toBe(1);
    expect(w.latency_band_1_3s).toBe(2);
    expect(w.latency_band_3_10s).toBe(1);
    expect(w.latency_band_gt_10s).toBe(1);
    const bands = w.latency_band_lt_1s + w.latency_band_1_3s + w.latency_band_3_10s + w.latency_band_gt_10s;
    expect(bands).toBe(w.searches);
  });
});

describe("REEA-871 retailer adapter attempts/failures", () => {
  it("folds attempts and failures under the same retailer keys as the offer counts", () => {
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 3 },
      serveOutcome: "full",
      serveLatencyMs: 900,
      adapterAttempts: { Xcite: 1, "Sultan Center": 1 },
      adapterFailures: { "Sultan Center": 1 },
    });
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: { Xcite: 1 },
      serveOutcome: "full",
      serveLatencyMs: 900,
      adapterAttempts: { Xcite: 1 },
    });
    const w = weeks["2026-W37"];
    expect(w.retailer_adapter_attempts).toEqual({ Xcite: 2, "Sultan Center": 1 });
    expect(w.retailer_adapter_failures).toEqual({ "Sultan Center": 1 });
    // failures ≤ attempts holds for every retailer present in either map.
    for (const [merchant, attempts] of Object.entries(w.retailer_adapter_attempts)) {
      expect(w.retailer_adapter_failures[merchant] ?? 0).toBeLessThanOrEqual(attempts);
    }
    // Sanitized like every other retailer name in the store.
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: {},
      serveOutcome: "full",
      serveLatencyMs: 900,
      adapterAttempts: { "Bad\u0000Name": 2 },
      adapterFailures: { "Bad\u0000Name": 1 },
    });
    expect(w.retailer_adapter_attempts["BadName"]).toBe(2);
    expect(w.retailer_adapter_failures["BadName"]).toBe(1);
  });

  it("clamps failures without attempts and negative/garbage counts instead of recording impossible math", () => {
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: {},
      serveOutcome: "full",
      serveLatencyMs: 900,
      adapterAttempts: { Xcite: 1, Jarir: -3 },
      adapterFailures: { Xcite: 7, Blink: 2 },
    });
    const w = weeks["2026-W37"];
    expect(w.retailer_adapter_attempts).toEqual({ Xcite: 1 });
    expect(w.retailer_adapter_failures).toEqual({ Xcite: 1 }); // clamped to attempts
    expect(w.retailer_adapter_failures["Blink"]).toBeUndefined();
    // A serve that ran no fan-out (memo hit) records no attempts at all.
    applySearchOutcome(weeks, "2026-W37", {
      zeroOffers: false,
      offersByRetailer: {},
      serveOutcome: "full",
      serveLatencyMs: 5,
    });
    expect(w.retailer_adapter_attempts).toEqual({ Xcite: 1 });
  });

  it("persists the extension through the store and backfills old-schema weeks on read", async () => {
    const kv = fakeKv();
    // An OLD-schema blob (REEA-807 fields only) as a pre-extension instance
    // would have written it.
    await kv.set(
      METRICS_KV_KEY,
      JSON.stringify({
        version: 1,
        weeks: {
          "2026-W36": {
            searches: 4,
            zero_offer_searches: 1,
            offers_by_retailer: { Xcite: 9 },
            link_smoke: { runs: 0, checked: 0, dead: 0, by_retailer: {} },
          },
        },
      }),
      60,
    );
    const old = await readWeeklyCounters({ kv });
    expect(old["2026-W36"].cold_serves_full).toBe(0);
    expect(old["2026-W36"].cold_serves_pending).toBe(0);
    expect(old["2026-W36"].retailer_adapter_attempts).toEqual({});
    expect(old["2026-W36"].latency_band_lt_1s).toBe(0);
    expect(old["2026-W36"].searches).toBe(4);

    await recordSearchOutcome(
      {
        zeroOffers: false,
        offersByRetailer: { Xcite: 2 },
        serveOutcome: "full",
        serveLatencyMs: 2_500,
        adapterAttempts: { Xcite: 1, Jarir: 1 },
        adapterFailures: { Jarir: 1 },
      },
      { kv, now: Date.UTC(2026, 8, 12) },
    );
    const weeks = await readWeeklyCounters({ kv });
    const w = weeks["2026-W37"];
    expect(w.searches).toBe(1);
    expect(w.cold_serves_full).toBe(1);
    expect(w.latency_band_1_3s).toBe(1);
    expect(w.retailer_adapter_attempts).toEqual({ Xcite: 1, Jarir: 1 });
    expect(w.retailer_adapter_failures).toEqual({ Jarir: 1 });
    // The old week rides along untouched, still readable.
    expect(weeks["2026-W36"].searches).toBe(4);
  });
});

describe("REEA-921 serveOutcomeOf guardrail", () => {
  it("a settled served document counts full regardless of the follow-up", () => {
    expect(serveOutcomeOf({ settled: true }, { settled: false })).toBe("full");
    expect(serveOutcomeOf({}, null)).toBe("full");
    expect(serveOutcomeOf({ settled: undefined }, { settled: undefined })).toBe("full");
  });

  it("a truncated serve with a delivered follow-up counts full — the page reached full offers", () => {
    expect(serveOutcomeOf({ settled: false }, { settled: undefined })).toBe("full");
    expect(serveOutcomeOf({ settled: false }, {})).toBe("full");
  });

  it("a truncated serve with a rejected/absent follow-up stays honest pending", () => {
    expect(serveOutcomeOf({ settled: false }, { settled: false })).toBe("pending");
    expect(serveOutcomeOf({ settled: false }, null)).toBe("pending");
    expect(serveOutcomeOf(null, null)).toBe("pending");
    // A truncated memo replay (the pre-fix pending class) has no live
    // follow-up of its own — the converged chain IS the served snapshot.
    expect(serveOutcomeOf({ settled: false }, { settled: false })).toBe("pending");
  });
});
