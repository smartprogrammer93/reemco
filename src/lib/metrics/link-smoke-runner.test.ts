/**
 * REEA-1078 — pins for the daily dead-link smoke runner (AC-A2): a week with
 * zero runs is the defect, so the runner must actually run (and record) once
 * per UTC day, and a failed run must NOT stamp the day — the next health
 * probe retries instead of leaving a silent gap.
 *
 * The checker itself is exercised by link-smoke-checker.test.ts; here the
 * network run is injected, and the store is isolated to a tmp METRICS_DIR so
 * the repo's own `.metrics` never drifts the assertions.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.METRICS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-linksmoke-"));
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const { maybeRunDailyLinkSmoke, utcDayOf } = await import("@/lib/metrics/link-smoke-runner");
const { isoWeekKey, readWeeklyCounters } = await import("@/lib/metrics");

const DAY = Date.UTC(2026, 10, 23, 5, 0, 0); // 2026-11-23 05:00Z
const NEXT_DAY = Date.UTC(2026, 10, 24, 5, 0, 0);

const result = {
  checked: 9,
  dead: 1,
  challenge: 1,
  ok: 7,
  byRetailer: { Xcite: { checked: 9, dead: 1, challenge: 1 } },
};

describe("REEA-1078 daily link smoke", () => {
  it("stamps the UTC day and records the aggregate once", async () => {
    expect(utcDayOf(DAY)).toBe("2026-11-23");
    const ran = await maybeRunDailyLinkSmoke({ origin: "http://127.0.0.1:3000", now: () => DAY, run: async () => result });
    expect(ran).toBe(true);
    // Same day, later probe: already done — no second network run.
    const again = await maybeRunDailyLinkSmoke({ origin: "http://127.0.0.1:3000", now: () => DAY + 3_600_000, run: async () => result });
    expect(again).toBe(false);

    const weeks = await readWeeklyCounters({});
    const w = weeks[isoWeekKey(DAY)];
    expect(w.link_smoke.runs).toBe(1);
    expect(w.link_smoke.checked).toBe(9);
    expect(w.link_smoke.dead).toBe(1);
    expect(w.link_smoke.challenge).toBe(1);
    expect(w.link_smoke.ok).toBe(7);
    expect(w.link_smoke.by_retailer.Xcite).toEqual({ checked: 9, dead: 1, challenge: 1 });
  });

  it("does not stamp a failed run — the next probe retries", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("feed unreachable");
      return result;
    };
    const failed = await maybeRunDailyLinkSmoke({ origin: "http://127.0.0.1:3000", now: () => NEXT_DAY, run: flaky });
    expect(failed).toBe(false);
    const retried = await maybeRunDailyLinkSmoke({ origin: "http://127.0.0.1:3000", now: () => NEXT_DAY, run: flaky });
    expect(retried).toBe(true);
    expect(calls).toBe(2);
  });

  it("never throws into the health probe", async () => {
    const day = Date.UTC(2026, 10, 25, 5, 0, 0);
    await expect(
      maybeRunDailyLinkSmoke({
        origin: "http://127.0.0.1:3000",
        now: () => day,
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBe(false);
  });
});
