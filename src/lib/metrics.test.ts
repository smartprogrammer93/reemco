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
  annotateLinkSmoke,
  applyLinkSmoke,
  applySearchOutcome,
  emptyWeek,
  isoWeekKey,
  latencyBandOf,
  linkSmokeRates,
  MAX_RETAILERS_PER_WEEK,
  METRICS_KV_KEY,
  normalizeWeek,
  pruneWeeks,
  readWeeklyCounters,
  readWeeklyCountersDetailed,
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
    expect(s.by_retailer["Xcite"]).toEqual({ checked: 11, dead: 1, challenge: 0 });
    expect(s.by_retailer["Jarir"]).toEqual({ checked: 4, dead: 0, challenge: 0 });
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

describe("REEA-935 applyLinkSmoke per-outcome fold", () => {
  it("folds ok/dead/challenge so every checked URL lands in exactly one outcome", () => {
    const weeks: WeekCountersMap = {};
    applyLinkSmoke(weeks, "2026-W38", {
      checked: 54,
      dead: 2,
      challenge: 3,
      byRetailer: {
        Blink: { checked: 8, dead: 0, challenge: 2 },
        Astore: { checked: 8, dead: 1 },
      },
    });
    const s = weeks["2026-W38"].link_smoke;
    expect(s).toMatchObject({ checked: 54, dead: 2, challenge: 3, ok: 49 });
    expect(s.by_retailer["Blink"]).toEqual({ checked: 8, dead: 0, challenge: 2 });
    expect(s.by_retailer["Astore"]).toEqual({ checked: 8, dead: 1, challenge: 0 });
  });

  it("clamps a hostile challenge payload against the ok bucket", () => {
    const weeks: WeekCountersMap = {};
    applyLinkSmoke(weeks, "2026-W38", {
      checked: 5,
      dead: 1,
      challenge: 99,
      byRetailer: {},
    });
    const s = weeks["2026-W38"].link_smoke;
    expect(s.dead).toBe(1);
    expect(s.challenge).toBe(4);
    expect(s.ok).toBe(0);
  });

  it("AC-4.1: a legacy (pre-extension) week backfills ok/challenge and never rewrites checked/dead", () => {
    const legacy = emptyWeek();
    legacy.link_smoke = { ...legacy.link_smoke, runs: 2, checked: 339, dead: 114, by_retailer: { "Amazon.eg": { checked: 49, dead: 15, challenge: 0 } } } as typeof legacy.link_smoke;
    // Simulate the pre-REEA-935 shape: no ok/challenge fields at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (legacy.link_smoke as any).ok;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (legacy.link_smoke as any).challenge;
    const normalized = normalizeWeek(legacy);
    expect(normalized.link_smoke.checked).toBe(339);
    expect(normalized.link_smoke.dead).toBe(114);
    expect(normalized.link_smoke.ok).toBe(225); // checked - dead: the rate it recorded
    expect(normalized.link_smoke.challenge).toBe(0);
    expect(normalized.link_smoke.by_retailer["Amazon.eg"]).toEqual({
      checked: 49,
      dead: 15,
      challenge: 0,
    });
    // Idempotent: a second pass changes nothing.
    expect(normalizeWeek(normalized).link_smoke).toEqual(normalized.link_smoke);
  });

  it("derives the dead rate over ok + dead and the challenge rate over checked", () => {
    expect(linkSmokeRates({ ...emptyWeek().link_smoke, ok: 43, dead: 3, challenge: 4, checked: 50 })).toEqual({
      dead_rate: 3 / 46,
      challenge_rate: 4 / 50,
    });
    expect(linkSmokeRates({ ...emptyWeek().link_smoke, ok: 0, dead: 0, challenge: 0, checked: 0 })).toEqual({
      dead_rate: 0,
      challenge_rate: 0,
    });
  });
});

describe("REEA-935 annotateLinkSmoke", () => {
  it("stamps the annotation on an existing week without touching counters", async () => {
    const dir = tmpDir();
    try {
      await recordLinkSmoke(
        { checked: 339, dead: 114, byRetailer: {} },
        { dir, now: Date.UTC(2026, 8, 9) },
      );
      await annotateLinkSmoke(
        {
          checkerContaminated: true,
          methodologyNote: "Pre/post daa7333 identity regime change; C1/C2/C4 ≈ 75–80% of recorded dead (REEA-922).",
        },
        { dir, week: "2026-W37" },
      );
      const weeks = await readWeeklyCounters({ dir });
      const ls = weeks["2026-W37"].link_smoke;
      expect(ls.checked).toBe(339);
      expect(ls.dead).toBe(114);
      expect(ls.checkerContaminated).toBe(true);
      expect(ls.methodologyNote).toContain("REEA-922");
    } finally {
      cleanDir(dir);
    }
  });

  it("never fabricates a bucket for a week with no stored record", async () => {
    const dir = tmpDir();
    try {
      await annotateLinkSmoke(
        { checkerContaminated: true, methodologyNote: "ghost week" },
        { dir, week: "2020-W01" },
      );
      const weeks = await readWeeklyCounters({ dir });
      expect(weeks["2020-W01"]).toBeUndefined();
    } finally {
      cleanDir(dir);
    }
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
      "challenge",
      "checked",
      "dead",
      "ok",
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

describe("REEA-996 classified weekly read + failed-read write guard", () => {
  /** KV fake with a checked read whose reachability the test controls. */
  function fakeKvChecked(): SharedKv & {
    writes: { key: string; value: string; ttl: number }[];
    failReads: boolean;
    hasKey: boolean;
  } {
    const store = new Map<string, string>();
    const writes: { key: string; value: string; ttl: number }[] = [];
    return {
      writes,
      failReads: true,
      hasKey: false,
      async get(key) {
        return store.get(key) ?? null;
      },
      async getChecked(key) {
        if (this.failReads) return { reachable: false, value: null };
        return { reachable: true, value: this.hasKey ? (store.get(key) ?? null) : null };
      },
      async set(key, value, ttlSeconds) {
        writes.push({ key, value, ttl: ttlSeconds });
        store.set(key, value);
        return true;
      },
    };
  }

  it("a failed KV read is classified kvReadFailed and still degrades to local data", async () => {
    const kv = fakeKvChecked();
    const dir = tmpDir();
    try {
      // Seed ONLY the local layer (as a KV-less write would).
      await recordSearchOutcome(
        { zeroOffers: false, offersByRetailer: { Xcite: 1 }, serveOutcome: "full", serveLatencyMs: 900 },
        { dir, kv: null, now: Date.UTC(2026, 8, 12) },
      );
      const read = await readWeeklyCountersDetailed({ dir, kv });
      expect(read.kvReadFailed).toBe(true);
      expect(read.source).toBe("local");
      expect(read.weeks["2026-W37"].searches).toBe(1);
      // The plain read is unchanged: same weeks, aggregation untouched.
      const plain = await readWeeklyCounters({ dir, kv });
      expect(plain["2026-W37"].searches).toBe(1);
    } finally {
      cleanDir(dir);
    }
  });

  it("a reachable missing key is honest: kvReadFailed stays false even when local is empty", async () => {
    const kv = fakeKvChecked();
    kv.failReads = false;
    const dir = tmpDir();
    try {
      const read = await readWeeklyCountersDetailed({ dir, kv });
      expect(read.weeks).toEqual({});
      expect(read.kvReadFailed).toBe(false); // a 200-empty answer is legitimate here
    } finally {
      cleanDir(dir);
    }
  });

  it("an unparseable stored blob counts as a failed read, not as an empty store", async () => {
    const kv = fakeKvChecked();
    kv.failReads = false;
    kv.hasKey = true;
    await kv.set(METRICS_KV_KEY, "not-json-at-all", 60);
    const dir = tmpDir();
    try {
      const read = await readWeeklyCountersDetailed({ dir, kv });
      expect(read.kvReadFailed).toBe(true);
      expect(read.weeks).toEqual({});
    } finally {
      cleanDir(dir);
    }
  });

  it("a failed shared read never arms the shared write — the 26-week blob is not clobbered", async () => {
    const kv = fakeKvChecked();
    const dir = tmpDir();
    try {
      // History exists on the shared layer; this instance can only see its
      // (seeded) local layer because the shared read keeps failing.
      await recordSearchOutcome(
        { zeroOffers: false, offersByRetailer: { Jarir: 4 }, serveOutcome: "full", serveLatencyMs: 900 },
        { dir, kv: null, now: Date.UTC(2026, 8, 12) }, // 2026-W37
      );
      await recordSearchOutcome(
        { zeroOffers: false, offersByRetailer: { Xcite: 1 }, serveOutcome: "full", serveLatencyMs: 900 },
        { dir, kv, now: Date.UTC(2026, 8, 14) }, // 2026-W38
      );
      expect(kv.writes).toHaveLength(0); // shared SET skipped over an unreadable blob
      const local = await readWeeklyCounters({ dir });
      expect(local["2026-W37"].offers_by_retailer).toEqual({ Jarir: 4 });
      expect(local["2026-W38"].offers_by_retailer).toEqual({ Xcite: 1 });
      // A healthy read still writes through to the shared blob.
      kv.failReads = false;
      kv.hasKey = true;
      await recordSearchOutcome(
        { zeroOffers: false, offersByRetailer: { Xcite: 2 }, serveOutcome: "full", serveLatencyMs: 900 },
        { dir, kv, now: Date.UTC(2026, 8, 14) },
      );
      expect(kv.writes).toHaveLength(1);
    } finally {
      cleanDir(dir);
    }
  });
});
