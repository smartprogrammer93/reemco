/**
 * REEA-1207 (Bet 7B Addition 1) — dead-lane retirement and canary re-admission.
 *
 * The AC for this slice: the lanes that answered every search with zero usable
 * offers leave the default fan-out, a lane returns only through
 * LANE_CANARY_SUCCESS_STREAK consecutive real canary answers, and the dispatch
 * layer honours that re-admission (a code-level retirement is not a permanent
 * veto). These tests pin the dispatch decision and the persisted-state shapes
 * the daily runner writes.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETIRED_LANES,
  LANE_CANARY_SUCCESS_STREAK,
  applyCanaryOutcome,
  emptyLaneHealthState,
  readLaneRetirement,
  readmittedLanesOf,
  retireLane,
  retiredLanesOf,
  resetRetiredLanesMemo,
} from "@/lib/collect/lane-health";
import { collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

/** A fetch stub that answers every hop with a minimal 200 HTML shell and
 *  records the hosts it was asked for. */
function recordingFetch(seen: string[]) {
  return async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    return new Response("<html><body><h1>nothing here</h1></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}

describe("REEA-1207 — dead-lane retirement", () => {
  it("retires the lanes that produced zero shopper offers in W48", () => {
    for (const lane of ["Lulu Hypermarket", "BinSina", "Yousifi", "YasO", "Hobby Center", "Bomai"]) {
      expect(DEFAULT_RETIRED_LANES).toContain(lane);
    }
    // Next Store stays retired (REEA-1078 S2).
    expect(DEFAULT_RETIRED_LANES).toContain("Next Store");
    // A lane that answers (Nest: 932 W48 offers) is NOT retired by this slice.
    expect(DEFAULT_RETIRED_LANES).not.toContain("Nest");
  });

  it("does not dispatch a retired lane, and dispatches it again once readmitted", async () => {
    resetDiscoveryCache();
    const seenDefault: string[] = [];
    await collectLiveResults("dyson", { fetchImpl: recordingFetch(seenDefault) as never, snapshots: false });
    expect(seenDefault.some((u) => u.includes("bomai.com"))).toBe(false);

    const seenReadmitted: string[] = [];
    await collectLiveResults("dyson", {
      fetchImpl: recordingFetch(seenReadmitted) as never,
      snapshots: false,
      readmittedLanes: ["Bomai"],
    });
    expect(seenReadmitted.some((u) => u.includes("bomai.com"))).toBe(true);
  });

  it("keeps a dynamically retired lane out even when the caller lists it as readmitted", async () => {
    resetDiscoveryCache();
    const seen: string[] = [];
    await collectLiveResults("dyson", {
      fetchImpl: recordingFetch(seen) as never,
      snapshots: false,
      retiredLanes: ["Eureka"],
      readmittedLanes: ["Eureka"],
    });
    expect(seen.some((u) => u.includes("eureka"))).toBe(false);
  });
});

describe("REEA-1207 — canary re-admission of a static retirement", () => {
  it("needs LANE_CANARY_SUCCESS_STREAK consecutive answers, then clears retiredAt", () => {
    let state = emptyLaneHealthState();
    retireLane(state, "Bomai", Date.now(), "static retirement (no answer from this egress)");
    expect(retiredLanesOf(state)).toContain("Bomai");

    // A failure resets the streak: N successes must be consecutive.
    let outcome = applyCanaryOutcome(state, "Bomai", false);
    state = outcome.state;
    expect(outcome.readmitted).toBe(false);

    for (let i = 1; i < LANE_CANARY_SUCCESS_STREAK; i += 1) {
      outcome = applyCanaryOutcome(state, "Bomai", true);
      state = outcome.state;
      expect(outcome.readmitted).toBe(false);
    }
    outcome = applyCanaryOutcome(state, "Bomai", true);
    state = outcome.state;
    expect(outcome.readmitted).toBe(true);
    expect(retiredLanesOf(state)).not.toContain("Bomai");
    expect(readmittedLanesOf(state)).toContain("Bomai");
  });

  it("reports retired and readmitted from one snapshot", async () => {
    resetRetiredLanesMemo();
    const blob = JSON.stringify({
      version: 1,
      lanes: {
        Bomai: { days: [], canaryStreak: 0, readmittedAt: "2026-11-26T10:00:00.000Z" },
        "Lulu Hypermarket": { days: [], canaryStreak: 0, retiredAt: "2026-11-26T09:00:00.000Z" },
      },
    });
    const kv = { get: async () => blob, set: async () => true };
    const read = await readLaneRetirement({ kv: kv as never, now: Date.now() });
    expect(read.retired).toEqual(["Lulu Hypermarket"]);
    expect(read.readmitted).toEqual(["Bomai"]);
    resetRetiredLanesMemo();
  });
});
