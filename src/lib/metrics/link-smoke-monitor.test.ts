/**
 * REEA-1252 — pins for the link-rot guardrail monitor. The monitor is the
 * "fails loudly" half of the ticket: a week under the 320 floor, short of
 * 1 run/day, or over the dead/challenge rate must produce a failure, and the
 * pre-guardrail week must not alert forever.
 */
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const monitor: any = await import("../../../scripts/link-smoke-monitor.mjs");

/** Wednesday 2026-12-02 10:00Z — 2026-W49, 3 elapsed days; W48 is complete. */
const NOW = Date.UTC(2026, 11, 2, 10, 0, 0);

function week(over: Record<string, unknown> = {}) {
  return {
    link_smoke: {
      runs: 7,
      checked: 400,
      dead: 20,
      ok: 380,
      challenge: 0,
      dead_rate: 0.05,
      challenge_rate: 0,
      by_retailer: { Xcite: { checked: 8, dead: 0, challenge: 0 } },
      ...over,
    },
  };
}

function payload(weeks: Record<string, unknown>) {
  return { generated_at: "2026-12-02T10:00:00Z", weeks };
}

describe("REEA-1252 link-smoke monitor", () => {
  it("passes a complete week at the floor and a prorated current week", () => {
    const result = monitor.evaluateLinkSmoke(
      payload({
        "2026-W48": week(),
        // 2026-W49 current, 3 elapsed days -> 138 checked / 3 runs floor.
        "2026-W49": week({ runs: 3, checked: 150, dead: 5, ok: 145, dead_rate: 0.0333 }),
      }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.currentWeek).toBe("2026-W49");
    expect(result.elapsedDays).toBe(3);
  });

  it("fails a complete week under the 320 checked floor", () => {
    const result = monitor.evaluateLinkSmoke(payload({ "2026-W48": week({ checked: 16, dead: 0, ok: 16 }) }), {
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f: { rule: string }) => f.rule)).toContain("checked_floor");
  });

  it("fails a complete week with fewer than 7 runs (one spot check is not a guardrail)", () => {
    const result = monitor.evaluateLinkSmoke(payload({ "2026-W48": week({ runs: 1 }) }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f: { rule: string }) => f.rule)).toContain("runs_floor");
  });

  it("fails when dead_rate exceeds 10%", () => {
    const result = monitor.evaluateLinkSmoke(
      payload({ "2026-W48": week({ checked: 400, dead: 50, ok: 350, dead_rate: 0.125 }) }),
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f: { rule: string }) => f.rule)).toContain("dead_rate");
  });

  it("fails when challenge_rate exceeds 25%", () => {
    const result = monitor.evaluateLinkSmoke(
      payload({ "2026-W48": week({ checked: 400, dead: 20, ok: 260, challenge: 120, challenge_rate: 0.3 }) }),
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f: { rule: string }) => f.rule)).toContain("challenge_rate");
  });

  it("grades the in-progress week against the prorated floor", () => {
    // Friday 2026-11-27 = 2026-W48, 5 elapsed days -> 230 checked / 5 runs.
    const friday = Date.UTC(2026, 10, 27, 10, 0, 0);
    const result = monitor.evaluateLinkSmoke(
      payload({ "2026-W48": week({ runs: 5, checked: 100, dead: 0, ok: 100 }) }),
      { now: friday },
    );
    expect(result.currentWeek).toBe("2026-W48");
    expect(result.elapsedDays).toBe(5);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f: { rule: string }) => f.rule)).toContain("checked_floor");
  });

  it("does not grade the pre-guardrail week (W47 runs=0)", () => {
    const result = monitor.evaluateLinkSmoke(
      payload({
        "2026-W47": week({ runs: 0, checked: 0, dead: 0, ok: 0, dead_rate: 0, challenge_rate: 0 }),
        "2026-W48": week(),
      }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.rows.map((r: { week: string }) => r.week)).toEqual(["2026-W48"]);
  });

  it("fails loudly when there is no graded week at all", () => {
    const result = monitor.evaluateLinkSmoke(payload({}), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f: { rule: string }) => f.rule)).toContain("no_data");
  });
});
