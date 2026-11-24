/**
 * REEA-1148 — bet #2 REVISE: the latency tail and measurement honesty.
 *
 * Pins the three things this change is supposed to guarantee, without a
 * browser and without new counters:
 *  1. the converged-chain wait used by the results after() tail is HARD
 *     capped — a serve still converging at the cap yields `null` AT the cap,
 *     so the recorded cold latency can never outlive the 8.5 s structural
 *     cap the methodology states (the W48 87 serves >10 s were the unbounded
 *     `staged.converged` await);
 *  2. the derived cold p90 uses the recording cap as the 3–10 s band's real
 *     upper edge, so it cannot report a tail no serve measured;
 *  3. the weekly payload carries the methodology block unconditionally, the
 *     AC-2 counter rename, and the invariant that keeps cold and warm
 *     separable (serves_full + serves_pending == searches == cold + warm
 *     bands).
 */
import { describe, expect, it } from "vitest";
import { convergedWithinCap } from "@/lib/collect/live-search";
import { coldBandP90Ms, emptyWeek } from "@/lib/metrics";
import { weeklyResponse } from "@/app/api/metrics/weekly/route";

type Snap = Parameters<typeof convergedWithinCap>[0] extends Promise<infer S> ? S : never;

describe("REEA-1148 — the cold recording clock is hard-capped", () => {
  it("a converged chain that lands inside the cap is returned with the snapshot", async () => {
    const snap = { products: [], notes: [], settled: true } as unknown as Snap;
    const out = await convergedWithinCap(Promise.resolve(snap), 50);
    expect(out).toBe(snap);
  });

  it("a chain still converging at the cap resolves null AT the cap (never later)", async () => {
    const started = Date.now();
    const hanging = new Promise<Snap>(() => {});
    const out = await convergedWithinCap(hanging, 25);
    expect(out).toBeNull();
    // The value and the recording clock come from the same bounded wait.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a rejected chain normalizes to null, exactly like a capped-out one", async () => {
    const out = await convergedWithinCap(Promise.reject(new Error("boom")) as Promise<Snap>, 50);
    expect(out).toBeNull();
  });
});

describe("REEA-1148 — derived cold p90 cannot claim a tail past the recording cap", () => {
  it("the W48 band shape (0/39/3715/87) interpolates to ~8.1 s, never 9.45 s", () => {
    const p90 = coldBandP90Ms({
      latency_band_lt_1s: 0,
      latency_band_1_3s: 39,
      latency_band_3_10s: 3_715,
      latency_band_gt_10s: 87,
    });
    expect(p90).not.toBeNull();
    expect(p90!).toBeLessThanOrEqual(8_500);
    expect(p90!).toBeGreaterThanOrEqual(8_000);
  });

  it("a mass in the 3–10 s band can never interpolate past 8.5 s", () => {
    const p90 = coldBandP90Ms({
      latency_band_lt_1s: 0,
      latency_band_1_3s: 0,
      latency_band_3_10s: 10_000,
      latency_band_gt_10s: 0,
    });
    // r = 9000 of 10000 → 0.9 into a band whose real top is the 8.5 s cap.
    expect(p90).toBeLessThanOrEqual(8_500);
    expect(p90!).toBeGreaterThanOrEqual(7_900);
  });

  it("an empty week reports no p90 instead of a fabricated zero", () => {
    expect(coldBandP90Ms({ latency_band_lt_1s: 0, latency_band_1_3s: 0, latency_band_3_10s: 0, latency_band_gt_10s: 0 })).toBeNull();
  });
});

describe("REEA-1148 — payload honesty invariants (AC-1/AC-2)", () => {
  it("publishes the renamed all-serve outcome split and keeps cold/warm separable", async () => {
    const week = emptyWeek();
    week.searches = 4;
    week.cold_serves_full = 3;
    week.cold_serves_pending = 1;
    week.latency_band_1_3s = 1;
    week.latency_band_3_10s = 2;
    week.latency_warm_band_lt_1s = 1;
    const res = weeklyResponse({ weeks: { "2026-W49": week }, source: "kv", kvReadFailed: false }, {}, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      methodology?: Record<string, string>;
    };
    const w = body.weeks["2026-W49"];
    expect(w.serves_full).toBe(3);
    expect(w.serves_pending).toBe(1);
    expect((w.serves_full as number) + (w.serves_pending as number)).toBe(w.searches);
    const cold = (w.latency_band_lt_1s as number) + (w.latency_band_1_3s as number) + (w.latency_band_3_10s as number) + (w.latency_band_gt_10s as number);
    const warm = (w.latency_warm_band_lt_1s as number) + (w.latency_warm_band_1_3s as number) + (w.latency_warm_band_3_10s as number) + (w.latency_warm_band_gt_10s as number);
    expect(cold + warm).toBe(w.searches);
    expect(w).not.toHaveProperty("cold_serves_full");
    expect(body.methodology).toBeTruthy();
    expect(body.methodology!.counter_naming).toContain("RENAMED");
  });
});
