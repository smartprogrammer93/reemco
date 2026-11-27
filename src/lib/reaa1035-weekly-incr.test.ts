/**
 * REEA-1035 — the weekly metrics writer on per-field atomic KV increments.
 *
 * Pins the two fragilities the 2026-09-14→09-20 production freeze exposed
 * (REEA-1034), fixed as a class:
 *  1. a failed shared READ never blocks the write any more — the v2 writer
 *     performs no store read at all, so an increment lands whenever the
 *     store accepts ANY write (the old skipSharedWrite posture shed 100% of
 *     post-deploy volume to the ephemeral layer under the REEA-1006 store
 *     degradation);
 *  2. concurrent serves can no longer lose updates — every increment is one
 *     server-side atomic INCR/INCRBY under its own key, so parallel
 *     recordSearchOutcome calls are additive instead of last-writer-wins.
 * Also pins the read side of the layout change: the frozen v1 blob
 * (`metrics:weekly:v1`) dual-reads under the v2 keys (blob ∪ keys is the
 * true total — v1 is never written again), the REEA-996 classified-read
 * semantics survive intact, the weekly route payload byte-shape is
 * unchanged, and degraded increments fold into the local layer without
 * double counting.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  annotateLinkSmoke,
  emptyWeek,
  isoWeekKey,
  METRICS_KV_KEY,
  METRICS_KV_TTL_S,
  METRICS_WEEKLY_V2_PREFIX,
  readWeeklyCounters,
  readWeeklyCountersDetailed,
  recordLinkSmoke,
  recordSearchOutcome,
  type SearchOutcome,
} from "@/lib/metrics";
import type { SharedKv } from "@/lib/collect/kv";

const WEEK_MS = Date.UTC(2026, 8, 14); // 2026-W38, the frozen week's successor
const WEEK = isoWeekKey(WEEK_MS);

function tmpDir(): string {
  return join(process.cwd(), ".metrics-tests", Math.random().toString(36).slice(2));
}

/**
 * The REEA-1035 KV fake: counters under their v2 keys, atomic INCR/INCRBY
 * (synchronous Map mutation — the same server-side atomicity the real store
 * applies), key enumeration + batched reads, and independently faultable
 * read / enumeration / increment planes so every degradation posture is
 * reachable from a test.
 */
function fakeIncrKv() {
  const entries = new Map<string, string>();
  const ttls = new Map<string, number>();
  const store = {
    // fault planes (methods read them off the returned object, so tests can
    // flip them at any time)
    failBlobReads: false, // get / getChecked
    failEnum: false, // keys / mget
    failIncr: false, // incr / incrBy
    // observation
    incrCalls: 0,
    incrByCalls: 0,
    sets: [] as { key: string; value: string; ttl: number }[],
    entries,
    ttls,
    async get(key: string) {
      if (store.failBlobReads) return null;
      return entries.get(key) ?? null;
    },
    async getChecked(key: string) {
      if (store.failBlobReads) return { reachable: false, value: null };
      return { reachable: true, value: entries.get(key) ?? null };
    },
    async set(key: string, value: string, ttlSeconds: number) {
      store.sets.push({ key, value, ttl: ttlSeconds });
      entries.set(key, value);
      ttls.set(key, ttlSeconds);
      return true;
    },
    async incr(key: string, ttlSeconds: number) {
      store.incrCalls++;
      if (store.failIncr) return null;
      const next = (Number.parseInt(entries.get(key) ?? "", 10) || 0) + 1;
      entries.set(key, String(next));
      if (next === 1) ttls.set(key, ttlSeconds);
      return next;
    },
    async incrBy(key: string, by: number, ttlSeconds: number) {
      store.incrByCalls++;
      if (store.failIncr) return null;
      const n = Math.max(1, Math.floor(by));
      const next = (Number.parseInt(entries.get(key) ?? "", 10) || 0) + n;
      entries.set(key, String(next));
      if (next === n) ttls.set(key, ttlSeconds);
      return next;
    },
    async keys(pattern: string) {
      if (store.failEnum) return null;
      const prefix = pattern.replace(/\*$/, "");
      return [...entries.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async mget(keys: string[]) {
      if (store.failEnum) return null;
      return keys.map((k) => entries.get(k) ?? null);
    },
  };
  return store satisfies SharedKv & typeof store;
}

function counter(kv: ReturnType<typeof fakeIncrKv>, key: string): number {
  return Number.parseInt(kv.entries.get(key) ?? "", 10) || 0;
}

const v2 = (suffix: string): string => `${METRICS_WEEKLY_V2_PREFIX}:${suffix}`;

function outcome(over: Partial<SearchOutcome> = {}): SearchOutcome {
  return {
    zeroOffers: false,
    offersByRetailer: { Xcite: 2, Jarir: 1 },
    serveOutcome: "full",
    serveLatencyMs: 900,
    adapterAttempts: { Xcite: 2, Jarir: 1 },
    adapterFailures: { Jarir: 1 },
    ...over,
  };
}

describe("REEA-1035 atomic write path", () => {

  it("increments land when EVERY read fails — the write no longer needs a read (REEA-1034 fragility #1)", async () => {
    const kv = fakeIncrKv();
    kv.failBlobReads = true;
    kv.failEnum = true;
    for (let i = 0; i < 3; i++) {
      await recordSearchOutcome(outcome(), { kv, now: WEEK_MS });
    }
    expect(counter(kv, v2(`${WEEK}:searches`))).toBe(3);
    expect(counter(kv, v2(`${WEEK}:offer:Xcite`))).toBe(6);
    expect(counter(kv, v2(`${WEEK}:fail:Jarir`))).toBe(3);
    // the v1 blob is never written by the atomic path — no RMW anywhere
    expect([...kv.entries.keys()].filter((k) => k.startsWith("metrics:weekly:v1"))).toEqual([]);
  });

  it("concurrent recordSearchOutcome never loses counts (REEA-1034 fragility #2)", async () => {
    const kv = fakeIncrKv();
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordSearchOutcome(
          outcome({
            serveOutcome: i % 2 === 0 ? "full" : "pending",
            serveLatencyMs: [900, 1500, 4000, 12000][i % 4],
            zeroOffers: i % 5 === 0,
          }),
          { kv, now: WEEK_MS },
        ),
      ),
    );
    const weeks = await readWeeklyCounters({ kv });
    const w = weeks[WEEK];
    expect(w.searches).toBe(N);
    expect(w.cold_serves_full + w.cold_serves_pending).toBe(N);
    expect(w.latency_band_lt_1s + w.latency_band_1_3s + w.latency_band_3_10s + w.latency_band_gt_10s).toBe(N);
    expect(w.latency_warm_band_lt_1s + w.latency_warm_band_1_3s + w.latency_warm_band_3_10s + w.latency_warm_band_gt_10s).toBe(0);
    expect(w.offers_by_retailer).toEqual({ Xcite: 50, Jarir: 25 });
    expect(w.retailer_adapter_attempts).toEqual({ Xcite: 50, Jarir: 25 });
    expect(w.retailer_adapter_failures).toEqual({ Jarir: 25 });
    expect(w.zero_offer_searches).toBe(5);
  });

  it("each recorded serve still splits exactly one cold-serve bucket and one latency band", async () => {
    const kv = fakeIncrKv();
    await recordSearchOutcome(outcome({ serveOutcome: "pending", serveLatencyMs: 12000 }), { kv, now: WEEK_MS });
    expect(counter(kv, v2(`${WEEK}:cold_serves_pending`))).toBe(1);
    expect(counter(kv, v2(`${WEEK}:cold_serves_full`))).toBe(0);
    expect(counter(kv, v2(`${WEEK}:latency_band_gt_10s`))).toBe(1);
  });

  // REEA-1078 — warm serves and comparison depth ride the same atomic layout.
  it("writes a warm serve into the warm band keys and folds comparison depth", async () => {
    const kv = fakeIncrKv();
    await recordSearchOutcome(
      outcome({
        serveKind: "warm",
        serveLatencyMs: 900,
        comparisonDepth: { cardsTotal: 6, cardsMultiRetailer: 3 },
      }),
      { kv, now: WEEK_MS },
    );
    expect(counter(kv, v2(`${WEEK}:latency_warm_band_lt_1s`))).toBe(1);
    expect(counter(kv, v2(`${WEEK}:latency_band_lt_1s`))).toBe(0);
    expect(counter(kv, v2(`${WEEK}:comparison_cards_total`))).toBe(6);
    expect(counter(kv, v2(`${WEEK}:comparison_cards_multi_retailer`))).toBe(3);
    const weeks = await readWeeklyCounters({ kv });
    const w = weeks[WEEK];
    expect(w.latency_warm_band_lt_1s).toBe(1);
    expect(w.comparison_cards_total).toBe(6);
    expect(w.comparison_cards_multi_retailer).toBe(3);
    expect(w.comparison_cards_multi_retailer).toBeLessThanOrEqual(w.comparison_cards_total);
  });

  // REEA-1261 AC-5 — a cross-market-only card must reach the weekly payload.
  it("persists cross_market_cards so a foreign-only exact card is visible in depth", async () => {
    const kv = fakeIncrKv();
    await recordSearchOutcome(
      outcome({
        comparisonDepth: { cardsTotal: 1, cardsMultiRetailer: 0, cardsCrossMarket: 1 },
      }),
      { kv, now: WEEK_MS },
    );
    expect(counter(kv, v2(`${WEEK}:comparison_cards_cross_market`))).toBe(1);
    const weeks = await readWeeklyCounters({ kv });
    expect(weeks[WEEK].comparison_cards_cross_market).toBe(1);
    expect(weeks[WEEK].comparison_cards_total).toBe(1);
  });

  it("a failed INCR degrades the increment to the local layer, never drops the request", async () => {
    const kv = fakeIncrKv();
    kv.failIncr = true;
    const dir = tmpDir();
    try {
      await recordSearchOutcome(outcome(), { kv, dir, now: WEEK_MS });
      expect(kv.entries.size).toBe(0); // nothing landed shared
      const local = await readWeeklyCounters({ dir, kv: null });
      expect(local[WEEK].searches).toBe(1);
      expect(local[WEEK].offers_by_retailer).toEqual({ Xcite: 2, Jarir: 1 });
    } finally {
      // local dir cleaned by the repo's own test convention (rmSync) — kept simple here
    }
  });

  it("a partially-landing incr-only store folds only the remainder to the local layer", async () => {
    const kv = fakeIncrKv();
    (kv as unknown as { incrBy?: unknown }).incrBy = undefined; // force the per-unit incr loop
    let calls = 0;
    const realIncr = kv.incr;
    kv.incr = async (key, ttl) => (calls++ < 3 ? realIncr(key, ttl) : null);
    const dir = tmpDir();
    try {
      // searches (1 incr) + zero_offer? no + cold full (1) + band (1) + offers 2+1 + attempts 2+1 + failures 1 = 9 incrs
      await recordSearchOutcome(outcome(), { kv, dir, now: WEEK_MS });
      expect(calls).toBeGreaterThanOrEqual(3);
      const sharedSearches = counter(kv, v2(`${WEEK}:searches`));
      const local = await readWeeklyCounters({ dir, kv: null });
      // shared landed part + local remainder == the full increment
      expect(sharedSearches + (local[WEEK]?.searches ?? 0)).toBe(1);
      expect(local[WEEK]?.offers_by_retailer ?? {}).toEqual({ Xcite: 2, Jarir: 1 });
    } finally {
      void dir;
    }
  });
});

describe("REEA-1035 dual read: frozen v1 blob ∪ v2 keys", () => {
  it("adds v2 increments on top of the frozen v1 history without double counting", async () => {
    const kv = fakeIncrKv();
    const v1Week = { ...emptyWeek(), searches: 10, offers_by_retailer: { Xcite: 4 } };
    await kv.set(METRICS_KV_KEY, JSON.stringify({ version: 1, weeks: { [WEEK]: v1Week } }), 60);
    await recordSearchOutcome(outcome(), { kv, now: WEEK_MS }); // searches+1, Xcite+2, Jarir+1
    const weeks = await readWeeklyCounters({ kv });
    expect(weeks[WEEK].searches).toBe(11);
    expect(weeks[WEEK].offers_by_retailer).toEqual({ Xcite: 6, Jarir: 1 });
  });

  it("REEA-996 semantics survive: a failed blob read with an EMPTY v2 keyspace is kvReadFailed", async () => {
    const kv = fakeIncrKv();
    kv.failBlobReads = true; // keys/mget still work → empty keyspace is enumerable
    const read = await readWeeklyCountersDetailed({ kv });
    expect(read.weeks).toEqual({});
    expect(read.kvReadFailed).toBe(true);
    expect(read.source).toBe("kv");
  });

  it("REEA-996 semantics survive: v2 data answers even when the legacy blob read fails", async () => {
    const kv = fakeIncrKv();
    await recordSearchOutcome(outcome(), { kv, now: WEEK_MS });
    kv.failBlobReads = true;
    const read = await readWeeklyCountersDetailed({ kv });
    expect(read.source).toBe("kv");
    expect(read.weeks[WEEK].searches).toBe(1);
    // data exists, so the loud-503 posture must not fire — but the failed
    // blob read stays classified (the empty-weeks + kvReadFailed combo is
    // what the weekly route turns into a 503).
    expect(read.kvReadFailed).toBe(true);
  });

  it("a store without incr/enum ops keeps the pre-change v1 blob RMW path end-to-end", async () => {
    const kv = fakeIncrKv();
    const legacy = {
      get: kv.get,
      set: kv.set,
    } as SharedKv;
    const dir = tmpDir();
    await recordSearchOutcome(outcome(), { kv: legacy, dir, now: WEEK_MS });
    // no incr on this fake → the legacy read-modify-write over the shared
    // blob, and the classified read answers from the blob exactly as the
    // pre-change code did (backward compat for old fakes is preserved).
    const read = await readWeeklyCountersDetailed({ kv: legacy, dir });
    expect(read.source).toBe("kv");
    expect(read.kvReadFailed).toBe(false);
    expect(read.weeks[WEEK].searches).toBe(1);
  });
});

describe("REEA-1035 stored schema + route byte-shape", () => {
  it("v2 keys carry counters and retailer names only, integer values, retention TTL armed on create", async () => {
    const kv = fakeIncrKv();
    await recordSearchOutcome(outcome(), { kv, now: WEEK_MS });
    await recordLinkSmoke(
      { checked: 7, dead: 1, challenge: 1, byRetailer: { Xcite: { checked: 7, dead: 1, challenge: 0 } } },
      { kv, now: WEEK_MS },
    );
    const keyRe =
      /^metrics:weekly:v2:\d{4}-W\d{2}:(searches|zero_offer_searches|cold_serves_full|cold_serves_pending|comparison_cards_total|comparison_cards_multi_retailer|comparison_cards_cross_market|latency_band_(lt_1s|1_3s|3_10s|gt_10s)|latency_warm_band_(lt_1s|1_3s|3_10s|gt_10s)|ls_(runs|checked|dead|ok|challenge)|(offer|att|fail|lsbr_checked|lsbr_dead|lsbr_challenge):[^:]+)$/;
    for (const [key, value] of kv.entries) {
      expect(key).toMatch(keyRe);
      expect(value).toMatch(/^\d+$/);
      expect(value).not.toMatch(/https?:\/\//);
      expect(kv.ttls.get(key)).toBe(METRICS_KV_TTL_S); // armed on create
    }
    expect(counter(kv, v2(`${WEEK}:ls_checked`))).toBe(7);
    expect(counter(kv, v2(`${WEEK}:lsbr_checked:Xcite`))).toBe(7);
    expect(counter(kv, v2(`${WEEK}:lsbr_dead:Xcite`))).toBe(1);
  });

  it("weekly route payload shape from the v2 layout: REEA-1148 renamed outcome split, derived p90, methodology", async () => {
    const { weeklyResponse } = await import("@/app/api/metrics/weekly/route");
    const kv = fakeIncrKv();
    await recordSearchOutcome(outcome(), { kv, now: WEEK_MS });
    await recordLinkSmoke(
      { checked: 7, dead: 1, byRetailer: { Xcite: { checked: 7, dead: 1 } } },
      { kv, now: WEEK_MS },
    );
    const read = await readWeeklyCountersDetailed({ kv });
    const body = (await weeklyResponse(read, {}, 8).json()) as {
      weeks: Record<string, Record<string, unknown>>;
    };
    const week = body.weeks[WEEK];
    expect(Object.keys(week).sort()).toEqual([
      "bot_serves",
      "comparison_depth",
      "cross_market_offers",
      "ctr_denominator_clean",
      "ctr_denominator_raw",
      "ctr_denominator_shopper",
      "filtered_empty_searches",
      "latency_band_1_3s",
      "latency_band_3_10s",
      "latency_band_gt_10s",
      "latency_band_lt_1s",
      "latency_p90_ms",
      "latency_warm_band_1_3s",
      "latency_warm_band_3_10s",
      "latency_warm_band_gt_10s",
      "latency_warm_band_lt_1s",
      "link_smoke",
      "offer_link_clicks",
      "offer_link_ctr_shopper",
      "offers_by_retailer",
      "retailer_adapter_attempts",
      "retailer_adapter_failures",
      "searches",
      "serves_full",
      "serves_pending",
      "share_whatsapp",
      "share_whatsapp_per_1k_serves",
      "shopper_serves",
      // REEA-1237 (PM scope extension) — the aggregate query-term Pareto
      "top_queries",
      "zero_offer_searches",
    ]);
    expect(Object.keys(week.link_smoke as object).sort()).toEqual([
      "by_retailer",
      "challenge",
      "challenge_rate",
      "checked",
      "dead",
      "dead_rate",
      "ok",
      "runs",
    ]);
    expect(week.searches).toBe(1);
    expect((week.offers_by_retailer as Record<string, number>).Xcite).toBe(2);
  });
});

describe("REEA-1035 annotation under the atomic layout", () => {
  it("stamps an existing week via one idempotent note SET and never touches counters", async () => {
    const kv = fakeIncrKv();
    await recordSearchOutcome(outcome(), { kv, now: WEEK_MS });
    const before = new Map(kv.entries);
    await annotateLinkSmoke(
      { checkerContaminated: true, methodologyNote: "checker bot-wall contaminated W38" },
      { kv, week: WEEK, now: WEEK_MS },
    );
    const noteKey = v2(`${WEEK}:ls_note`);
    expect(kv.entries.get(noteKey)).toBe(
      JSON.stringify({ checkerContaminated: true, methodologyNote: "checker bot-wall contaminated W38" }),
    );
    for (const [k, v] of before) expect(kv.entries.get(k)).toBe(v); // counters untouched
    const weeks = await readWeeklyCounters({ kv });
    expect(weeks[WEEK].link_smoke.checkerContaminated).toBe(true);
    expect(weeks[WEEK].link_smoke.methodologyNote).toBe("checker bot-wall contaminated W38");
    expect(weeks[WEEK].searches).toBe(1);
  });

  it("never fabricates a bucket for a week with no stored record", async () => {
    const kv = fakeIncrKv();
    await annotateLinkSmoke(
      { checkerContaminated: true, methodologyNote: "no such week" },
      { kv, week: "2030-W01", now: WEEK_MS },
    );
    expect([...kv.entries.keys()].filter((k) => k.includes("ls_note"))).toEqual([]);
  });
});
