/**
 * REEA-1078 S2 — dead-lane retirement, the 7-day auto-retire rule and canary
 * re-admission. These pin the policy boundaries the AC names: Next Store is
 * out of the default fan-out, a lane that failed every attempt for 7 days is
 * retired automatically, and only N consecutive canary successes return it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SharedKv } from "@/lib/collect/kv";
import {
  DEFAULT_RETIRED_LANES,
  LANE_CANARY_SUCCESS_STREAK,
  LANE_HEALTH_DAY_KEY,
  LANE_HEALTH_KEY,
  LANE_RETIRE_WINDOW_DAYS,
  applyCanaryOutcome,
  applyLaneAttempts,
  emptyLaneHealth,
  emptyLaneHealthState,
  laneShouldRetire,
  maybeRunDailyLaneHealth,
  normalizeLaneHealthState,
  pruneLaneDays,
  readRetiredLanes,
  recordLaneAttempts,
  resetLaneHealthRunState,
  retiredLanesOf,
  utcDayOf,
} from "@/lib/collect/lane-health";

const DAY = 86_400_000;

/** Minimal in-memory SharedKv fake (get/set only — the lane-health store uses
 *  no counters). `down` simulates an unreachable store. */
function fakeKv(seed: Record<string, string> = {}, down = false): SharedKv & { dump: () => Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    async get(key: string) {
      if (down) return null;
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key: string, value: string) {
      if (down) return false;
      map.set(key, value);
      return true;
    },
    dump: () => Object.fromEntries(map),
  };
}

function laneWithStreak(startedAt: number) {
  return {
    days: [
      { day: utcDayOf(startedAt), attempts: 4, failures: 4 },
      { day: utcDayOf(startedAt + 6 * DAY), attempts: 2, failures: 2 },
    ],
    failingSince: new Date(startedAt).toISOString(),
    canaryStreak: 0,
  };
}

describe("DEFAULT_RETIRED_LANES (AC-6)", () => {
  it("retires Next Store at the code level, with the lane still declared elsewhere", () => {
    expect(DEFAULT_RETIRED_LANES).toContain("Next Store");
  });
});

describe("applyLaneAttempts — daily evidence from the serve telemetry", () => {
  const now = Date.parse("2026-11-23T10:00:00.000Z");

  it("starts a failure streak when every attempt failed", () => {
    const next = applyLaneAttempts(
      emptyLaneHealthState(),
      { attempts: { "Next Store": 2 }, failures: { "Next Store": 2 } },
      now,
    );
    expect(next.lanes["Next Store"].days).toEqual([
      { day: "2026-11-23", attempts: 2, failures: 2 },
    ]);
    expect(next.lanes["Next Store"].failingSince).toBe("2026-11-23T10:00:00.000Z");
  });

  it("clears the streak on any successful attempt (100% failure is the rule)", () => {
    const failing = applyLaneAttempts(
      emptyLaneHealthState(),
      { attempts: { Lulu: 3 }, failures: { Lulu: 3 } },
      now,
    );
    const recovered = applyLaneAttempts(
      failing,
      { attempts: { Lulu: 1 }, failures: { Lulu: 0 } },
      now + DAY,
    );
    expect(recovered.lanes.Lulu.failingSince).toBeUndefined();
    expect(recovered.lanes.Lulu.lastSuccessAt).toBe("2026-11-24T10:00:00.000Z");
  });

  it("accumulates a day's counts and never inverts failures > attempts", () => {
    const first = applyLaneAttempts(
      emptyLaneHealthState(),
      { attempts: { Blink: 2 }, failures: { Blink: 1 } },
      now,
    );
    const second = applyLaneAttempts(
      first,
      { attempts: { Blink: 2 }, failures: { Blink: 5 } },
      now + 3_600_000,
    );
    expect(second.lanes.Blink.days[0]).toEqual({ day: "2026-11-23", attempts: 4, failures: 3 });
  });

  it("keeps the input state untouched (pure fold)", () => {
    const state = emptyLaneHealthState();
    applyLaneAttempts(state, { attempts: { Xcite: 1 }, failures: { Xcite: 1 } }, now);
    expect(state.lanes).toEqual({});
  });
});

describe("laneShouldRetire (AC-7: 100% failure for 7 days)", () => {
  const now = Date.parse("2026-11-23T00:00:00.000Z");

  it("does not retire a lane that has failed for less than 7 days", () => {
    const lane = laneWithStreak(now - (LANE_RETIRE_WINDOW_DAYS - 1) * DAY);
    expect(laneShouldRetire(lane, now)).toBe(false);
  });

  it("retires a lane whose current all-failure streak is 7 days old", () => {
    const lane = laneWithStreak(now - LANE_RETIRE_WINDOW_DAYS * DAY);
    expect(laneShouldRetire(lane, now)).toBe(true);
  });

  it("never retires a lane that was never attempted", () => {
    expect(laneShouldRetire(emptyLaneHealth(), now)).toBe(false);
    expect(laneShouldRetire(undefined, now)).toBe(false);
  });

  it("does not retire on stale evidence outside the window", () => {
    const lane = laneWithStreak(now - 30 * DAY);
    // failingSince is old, but no attempt landed inside the trailing window.
    expect(laneShouldRetire(lane, now)).toBe(false);
  });
});

describe("applyCanaryOutcome (AC-7: canary re-admission)", () => {
  const now = Date.parse("2026-11-23T00:00:00.000Z");

  it("requires N consecutive successes, and a failure resets the streak", () => {
    const state = emptyLaneHealthState();
    state.lanes.Lulu = { ...laneWithStreak(now - 9 * DAY), retiredAt: new Date(now).toISOString() };
    applyCanaryOutcome(state, "Lulu", true, now);
    applyCanaryOutcome(state, "Lulu", true, now + DAY);
    expect(state.lanes.Lulu.canaryStreak).toBe(2);
    expect(state.lanes.Lulu.retiredAt).toBeDefined();
    applyCanaryOutcome(state, "Lulu", false, now + 2 * DAY);
    expect(state.lanes.Lulu.canaryStreak).toBe(0);
    expect(state.lanes.Lulu.retiredAt).toBeDefined();
  });

  it("returns the lane to the fan-out at the configured streak", () => {
    const state = emptyLaneHealthState();
    state.lanes.Lulu = { ...laneWithStreak(now - 9 * DAY), retiredAt: new Date(now).toISOString() };
    for (let i = 0; i < LANE_CANARY_SUCCESS_STREAK; i++) {
      applyCanaryOutcome(state, "Lulu", true, now + i * DAY);
    }
    expect(state.lanes.Lulu.retiredAt).toBeUndefined();
    expect(state.lanes.Lulu.readmittedAt).toBeDefined();
    expect(state.lanes.Lulu.failingSince).toBeUndefined();
    expect(retiredLanesOf(state)).toEqual([]);
  });
});

describe("maybeRunDailyLaneHealth — the scheduled pass", () => {
  beforeEach(() => resetLaneHealthRunState());

  it("retires a 7-day all-failure lane and canaries retired lanes once per day", async () => {
    const now = Date.parse("2026-11-23T00:00:00.000Z");
    const kv = fakeKv();
    const canaries: string[] = [];
    const summary = await maybeRunDailyLaneHealth({
      now: () => now,
      kv,
      allLanes: ["Next Store", "Xcite"],
      canaryTargets: [
        { merchant: "Next Store", canary: async (m) => { canaries.push(m); return true; } },
        { merchant: "Xcite", canary: async (m) => { canaries.push(m); return true; } },
      ],
    });
    // Seed a failing lane into the store first — the run above had no evidence.
    expect(summary?.retiredNow).toEqual([]);

    const seeded = fakeKv({
      [LANE_HEALTH_KEY]: JSON.stringify({
        version: 1,
        lanes: { Lulu: laneWithStreak(now - 8 * DAY) },
      }),
    });
    const run = await maybeRunDailyLaneHealth({
      now: () => now + DAY,
      kv: seeded,
      allLanes: ["Lulu", "Xcite"],
      canaryTargets: [
        { merchant: "Lulu", canary: async (m) => { canaries.push(m); return true; } },
        { merchant: "Next Store", canary: async (m) => { canaries.push(m); return true; } },
      ],
    });
    expect(run?.retiredNow).toContain("Lulu");
    expect(run?.canaried).toContain("Next Store"); // static retirement canaried
    expect(run?.canaried).toContain("Lulu");
    expect(canaries).toContain("Next Store");
    const stored = JSON.parse(seeded.dump()[LANE_HEALTH_KEY]) as { lanes: Record<string, { retiredAt?: string }> };
    expect(stored.lanes.Lulu.retiredAt).toBeDefined();
    expect(stored.lanes["Next Store"].retiredAt).toBeDefined();
    expect(seeded.dump()[LANE_HEALTH_DAY_KEY]).toBe("2026-11-24");
  });

  it("re-admits a retired lane only after the configured consecutive canaries", async () => {
    resetLaneHealthRunState();
    const start = Date.parse("2026-11-23T00:00:00.000Z");
    const kv = fakeKv();
    const targets = [{ merchant: "Next Store", canary: async () => true }];
    const seen: (string[] | undefined)[] = [];
    for (let day = 0; day <= LANE_CANARY_SUCCESS_STREAK; day++) {
      const summary = await maybeRunDailyLaneHealth({
        now: () => start + day * DAY,
        kv,
        allLanes: ["Xcite"],
        canaryTargets: targets,
      });
      seen.push(summary?.readmitted);
    }
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([]);
    // The third consecutive canary answer is the one that readmits.
    expect(seen[LANE_CANARY_SUCCESS_STREAK - 1]).toContain("Next Store");
    expect(seen[LANE_CANARY_SUCCESS_STREAK]).toEqual([]);
    const stored = JSON.parse(kv.dump()[LANE_HEALTH_KEY]) as { lanes: Record<string, { retiredAt?: string }> };
    expect(stored.lanes["Next Store"].retiredAt).toBeUndefined();
  });

  it("does not run twice in the same UTC day", async () => {
    resetLaneHealthRunState();
    const now = Date.parse("2026-11-23T00:00:00.000Z");
    const kv = fakeKv();
    const deps = { now: () => now, kv, allLanes: [] as string[], canaryTargets: [] as { merchant: string; canary: () => Promise<boolean> }[] };
    expect(await maybeRunDailyLaneHealth(deps)).not.toBeNull();
    expect(await maybeRunDailyLaneHealth(deps)).toBeNull();
  });

  it("fails open: an unreachable store leaves the previous retired set alone", async () => {
    resetLaneHealthRunState();
    const down = fakeKv({}, true);
    expect(await maybeRunDailyLaneHealth({
      now: () => Date.parse("2026-11-23T00:00:00.000Z"),
      kv: down,
      allLanes: ["Xcite"],
      canaryTargets: [],
    })).toBeNull();
  });
});

describe("recordLaneAttempts / readRetiredLanes", () => {
  beforeEach(() => resetLaneHealthRunState());

  it("persists per-day evidence and reads the retired set back", async () => {
    const kv = fakeKv();
    const now = Date.parse("2026-11-23T00:00:00.000Z");
    await recordLaneAttempts(
      { attempts: { "Next Store": 3 }, failures: { "Next Store": 3 } },
      { kv, now },
    );
    expect(await readRetiredLanes({ kv, now })).toEqual([]); // not retired yet
    const stored = JSON.parse(kv.dump()[LANE_HEALTH_KEY]) as {
      lanes: Record<string, { days: { attempts: number }[] }>;
    };
    expect(stored.lanes["Next Store"].days[0].attempts).toBe(3);
  });

  it("fails open when the store is unreachable (nothing extra retired)", async () => {
    resetLaneHealthRunState();
    expect(await readRetiredLanes({ kv: fakeKv({}, true) })).toEqual([]);
  });

  it("drops evidence older than the retention window", () => {
    const now = Date.parse("2026-11-23T00:00:00.000Z");
    const state = emptyLaneHealthState();
    state.lanes.Xcite = {
      days: [
        { day: utcDayOf(now - 30 * DAY), attempts: 9, failures: 9 },
        { day: utcDayOf(now), attempts: 1, failures: 1 },
      ],
      canaryStreak: 0,
    };
    expect(pruneLaneDays(state, now).lanes.Xcite.days).toEqual([
      { day: "2026-11-23", attempts: 1, failures: 1 },
    ]);
  });
});

describe("normalizeLaneHealthState", () => {
  it("survives malformed input without inventing data", () => {
    expect(normalizeLaneHealthState(null)).toEqual(emptyLaneHealthState());
    expect(normalizeLaneHealthState({ lanes: "nope" })).toEqual(emptyLaneHealthState());
    const state = normalizeLaneHealthState({
      lanes: {
        Xcite: {
          days: [{ day: "2026-11-23", attempts: -2, failures: 99 }, { day: "junk", attempts: 1 }],
          canaryStreak: -1,
          retiredAt: "not-a-date",
        },
      },
    });
    expect(state.lanes.Xcite.days).toEqual([{ day: "2026-11-23", attempts: 0, failures: 0 }]);
    expect(state.lanes.Xcite.canaryStreak).toBe(0);
    expect(state.lanes.Xcite.retiredAt).toBeUndefined();
  });
});
