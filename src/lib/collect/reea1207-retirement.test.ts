/**
 * REEA-1207 (Bet 7B) — lane retirement boundaries.
 *
 * CEO directive on REEA-1216: a lane that returns no offers is FIXED, not
 * killed (the repair is REEA-1221). 7B therefore must not retire the six
 * zero-offer lanes; the only code-level retirement stays Next Store, and a
 * lane that IS retired must be able to come back through the canary — a static
 * retirement is not a permanent veto.
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

describe("REEA-1207 — no lane is retired for failing", () => {
  it("keeps the fixable zero-offer lanes in the fan-out and only the ruled-absent ones out", () => {
    // REEA-1221 — the lanes we fixed or that still answer stay dispatched.
    for (const lane of ["Lulu Hypermarket", "BinSina", "Yousifi", "Next Store", "Ounass"]) {
      expect(DEFAULT_RETIRED_LANES).not.toContain(lane);
    }
    // PM's REEA-1225 ruling (2026-11-26) took these three out on "no
    // addressable catalogue" evidence — adapters and tests stay.
    for (const lane of ["YasO", "Hobby Center", "Bomai"]) {
      expect(DEFAULT_RETIRED_LANES).toContain(lane);
    }
  });

  it("dispatches a lane a canary readmitted, and keeps a dynamic retirement out", async () => {
    resetDiscoveryCache();
    const seenDefault: string[] = [];
    await collectLiveResults("dyson", { fetchImpl: recordingFetch(seenDefault) as never, snapshots: false });
    // REEA-1221 — no lane is statically retired any more, so Next Store is
    // contacted on a default run.
    expect(seenDefault.some((u) => u.includes("nextstore"))).toBe(true);

    const seenReadmitted: string[] = [];
    await collectLiveResults("dyson", {
      fetchImpl: recordingFetch(seenReadmitted) as never,
      snapshots: false,
      readmittedLanes: ["Next Store"],
    });
    expect(seenReadmitted.some((u) => u.includes("nextstore"))).toBe(true);

    // A dynamic retirement outranks a readmitted list: the 7-day rule wins.
    const seenDynamic: string[] = [];
    await collectLiveResults("dyson", {
      fetchImpl: recordingFetch(seenDynamic) as never,
      snapshots: false,
      retiredLanes: ["Eureka"],
      readmittedLanes: ["Eureka"],
    });
    expect(seenDynamic.some((u) => u.includes("eureka"))).toBe(false);
  });
});

describe("REEA-1207 — canary re-admission of a static retirement", () => {
  it("needs LANE_CANARY_SUCCESS_STREAK consecutive answers, then clears retiredAt", () => {
    let state = emptyLaneHealthState();
    // REEA-1221 — the static list is empty, so retire on evidence: the
    // canary ladder itself is what this test pins.
    retireLane(state, "Next Store", Date.now(), "no successful answer for 7 days");
    expect(retiredLanesOf(state)).toContain("Next Store");

    // A failure resets the streak: N successes must be consecutive.
    let outcome = applyCanaryOutcome(state, "Next Store", false);
    state = outcome.state;
    expect(outcome.readmitted).toBe(false);

    for (let i = 1; i < LANE_CANARY_SUCCESS_STREAK; i += 1) {
      outcome = applyCanaryOutcome(state, "Next Store", true);
      state = outcome.state;
      expect(outcome.readmitted).toBe(false);
    }
    outcome = applyCanaryOutcome(state, "Next Store", true);
    state = outcome.state;
    expect(outcome.readmitted).toBe(true);
    expect(retiredLanesOf(state)).not.toContain("Next Store");
    expect(readmittedLanesOf(state)).toContain("Next Store");
  });

  it("reports retired and readmitted from one snapshot", async () => {
    resetRetiredLanesMemo();
    const blob = JSON.stringify({
      version: 1,
      lanes: {
        "Next Store": { days: [], canaryStreak: 0, readmittedAt: "2026-11-26T10:00:00.000Z" },
        "Lulu Hypermarket": { days: [], canaryStreak: 0, retiredAt: "2026-11-26T09:00:00.000Z" },
      },
    });
    const kv = { get: async () => blob, set: async () => true };
    const read = await readLaneRetirement({ kv: kv as never, now: Date.now() });
    expect(read.retired).toEqual(["Lulu Hypermarket"]);
    expect(read.readmitted).toEqual(["Next Store"]);
    resetRetiredLanesMemo();
  });
});
