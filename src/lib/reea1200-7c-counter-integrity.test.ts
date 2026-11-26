/**
 * REEA-1200 — Bet 7C fold-in (counter integrity): the weekly metrics payload
 * publishes the CTR denominators as separate integers and names the
 * population behind each.
 *
 * AC 7C-3: `ctr_denominator_clean` and `ctr_denominator_raw` are separate
 * integers and `methodology` states the population for each.
 * AC 7C-4: clean ≤ raw, and the difference is attributable to the named
 * `bot_serves` counter.
 * AC 7C-5: aggregate-only, integer, `no-store`, PII-free.
 */
import { describe, expect, it } from "vitest";
import { applySearchOutcome, emptyWeek, type WeekCountersMap } from "@/lib/metrics";
import { weeklyResponse } from "@/app/api/metrics/weekly/route";

const WEEK = "2026-W48";

function serve(overrides: Partial<Parameters<typeof applySearchOutcome>[2]> = {}) {
  return {
    zeroOffers: false,
    offersByRetailer: { Xcite: 2 },
    serveOutcome: "full" as const,
    serveLatencyMs: 1200,
    serveKind: "cold" as const,
    ...overrides,
  };
}

describe("AC 7C-3/7C-4 — separate denominators, named subtraction", () => {
  it("folds a bot serve into the named bot_serves counter", () => {
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, WEEK, serve());
    applySearchOutcome(weeks, WEEK, serve({ botServe: true }));
    expect(weeks[WEEK].searches).toBe(2);
    expect(weeks[WEEK].bot_serves).toBe(1);
    expect(emptyWeek().bot_serves).toBe(0);
  });

  it("publishes raw and clean as separate integers with an auditable difference", async () => {
    const weeks: WeekCountersMap = { [WEEK]: emptyWeek() };
    applySearchOutcome(weeks, WEEK, serve());
    applySearchOutcome(weeks, WEEK, serve());
    applySearchOutcome(weeks, WEEK, serve());
    applySearchOutcome(weeks, WEEK, serve({ botServe: true }));
    const res = weeklyResponse({ weeks, source: "local", kvReadFailed: false }, { [WEEK]: 3 }, 8);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      methodology: Record<string, string>;
    };
    const w = body.weeks[WEEK];
    expect(w.ctr_denominator_raw).toBe(4);
    expect(w.ctr_denominator_clean).toBe(3);
    expect(w.bot_serves).toBe(1);
    // AC 7C-4 — the difference is attributable to the named counter.
    expect((w.ctr_denominator_raw as number) - (w.ctr_denominator_clean as number)).toBe(
      w.bot_serves,
    );
    expect(w.ctr_denominator_clean as number).toBeLessThanOrEqual(w.ctr_denominator_raw as number);
    // AC 7C-3 — the methodology states the population for each denominator.
    expect(body.methodology.ctr_denominators).toContain("ctr_denominator_raw");
    expect(body.methodology.ctr_denominators).toContain("ctr_denominator_clean");
    expect(body.methodology.ctr_denominators).toContain("bot_serves");
  });

  it("never lets a hostile blob invert the invariant", async () => {
    const week = emptyWeek();
    week.searches = 3;
    week.bot_serves = 9; // hostile: more bot serves than serves
    const res = weeklyResponse(
      { weeks: { [WEEK]: week }, source: "local", kvReadFailed: false },
      {},
      8,
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, number>> };
    expect(body.weeks[WEEK].ctr_denominator_clean).toBe(0);
    expect(body.weeks[WEEK].ctr_denominator_raw).toBe(3);
    expect(body.weeks[WEEK].ctr_denominator_clean).toBeLessThanOrEqual(
      body.weeks[WEEK].ctr_denominator_raw,
    );
  });

  it("is aggregate-only and PII-free: integers and methodology strings only", async () => {
    const weeks: WeekCountersMap = { [WEEK]: emptyWeek() };
    applySearchOutcome(weeks, WEEK, serve({ botServe: true }));
    const res = weeklyResponse({ weeks, source: "local", kvReadFailed: false }, {}, 8);
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      methodology: Record<string, string>;
    };
    const w = body.weeks[WEEK];
    for (const key of ["ctr_denominator_raw", "ctr_denominator_clean", "bot_serves"]) {
      expect(Number.isInteger(w[key])).toBe(true);
    }
    // The only strings on the payload are retailer names and methodology
    // prose — never a query, user, session, IP or UA.
    const scalarStrings = Object.entries(w).filter(([, v]) => typeof v === "string");
    expect(scalarStrings).toHaveLength(0);
    for (const value of Object.values(body.methodology)) expect(typeof value).toBe("string");
  });
});
