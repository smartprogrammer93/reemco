/**
 * REEA-1207 AC 7B-3 / 7B-4 — lane-failure counting and coverage-line honesty.
 *
 * A dispatched lane that yields 0 usable hits with no explicit "no match" must
 * settle as a BLOCKED failure with a named cause, so `retailer_adapter_failures`
 * stops reading 0 for a lane that delivered nothing, and the coverage line names
 * it as unreachable. A lane that answered with zero rows is an explicit "no
 * match" and must never be called unreachable.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { collectLiveResultsStaged, collectSettled, resetDiscoveryCache } from "@/lib/collect/live-search";
import { coverageLine, coverageParts, type LiveSearchResult } from "@/lib/collect/coverage";

/** Empty 200 for every hop; JSON hops get "{}" so a parser that reads a
 *  payload returns [] honestly instead of throwing. */
const emptyAnswer = (url: string) =>
  /xcite|algolia|json/i.test(url)
    ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    : new Response("<html><body><h1>nothing here</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
const emptyHtml = () => emptyAnswer("");

describe("REEA-1207 AC 7B-3 — a silent zero is a failure, not an answer", () => {
  it("settles a lane that cannot prove it answered as a blocked failure", async () => {
    const silent = {
      merchant: "Bomai",
      country: "KW" as const,
      silentWhenEmpty: true,
      collect: async () => [],
    };
    const settled = await collectSettled(silent as never, "dyson", (async (u: string) => emptyAnswer(u)) as never);
    expect(settled.hits).toEqual([]);
    expect(settled.error).toMatch(/^blocked: no usable payload/);
  });

  it("keeps a lane that parsed a payload as an explicit no-match", async () => {
    const answered = {
      merchant: "Xcite",
      country: "KW" as const,
      collect: async () => [],
    };
    const settled = await collectSettled(answered as never, "dyson", (async (u: string) => emptyAnswer(u)) as never);
    expect(settled.hits).toEqual([]);
    expect(settled.error).toBeUndefined();
  });

  it("counts the blocked settle in the per-retailer telemetry", async () => {
    resetDiscoveryCache();
    const staged = collectLiveResultsStaged("dyson", {
      fetchImpl: (async (u: string) => emptyAnswer(u)) as never,
      snapshots: false,
    });
    await staged.allSettled;
    const telemetry = await staged.adapterTelemetry;
    // REEA-1221 — PM's REEA-1225 ruling retired Bomai / Hobby Center / YasO on
    // "no addressable catalogue", so they are no longer dispatched; the lanes
    // asserted here are the ones still in the fan-out that cannot prove an
    // answer from an empty shell.
    for (const lane of ["Nest", "BinSina", "Lulu Hypermarket"]) {
      expect(telemetry.attempts[lane], `${lane} attempted`).toBeGreaterThan(0);
      expect(telemetry.failures[lane], `${lane} counted as a failure`).toBeGreaterThan(0);
    }
    // A lane that answered with nothing (explicit no-match) stays at zero
    // failures: the counter must not blame a store for not stocking a query.
    expect(telemetry.failures["Xcite"] ?? 0).toBe(0);
  });
});

describe("REEA-1207 AC 7B-4 — coverage line names blocked lanes, never a no-match lane", () => {
  const notes = [
    { merchant: "Bomai", hits: 0, coupons: 0, error: "blocked: no usable payload (0 hits, no explicit no-match from Bomai)" },
    { merchant: "YasO", hits: 0, coupons: 0, error: "blocked: no usable payload (0 hits, no explicit no-match from YasO)" },
    { merchant: "Aster Pharmacy", hits: 0, coupons: 0 },
    { merchant: "Xcite", hits: 2, coupons: 0 },
  ] as LiveSearchResult["notes"];

  it("names blocked lanes as unreachable and a zero-row answer as no match", () => {
    const en = coverageLine(notes, "en", [], [], "dyson");
    expect(en).toContain("Unreachable: Bomai");
    expect(en).toContain("YasO");
    expect(en).toContain("No match at Aster Pharmacy");
    // One statement per lane: a blocked lane is not also "No match at".
    expect(en).not.toContain("No match at Bomai");
  });

  it("renders the same distinction in Arabic", () => {
    const ar = coverageLine(notes, "ar", [], [], "dyson");
    expect(ar).toContain("تعذّر الوصول إلى");
    expect(ar).toContain("Bomai");
    expect(ar).toContain("لا توجد مطابقة لدى");
  });

  it("does not name a lane that actually rendered an offer", () => {
    const rendered = [{ productId: "p1", title: "Dyson", offers: [{ merchant: "Bomai" }] }] as never;
    const parts = coverageParts(notes, "en", rendered, [], "dyson");
    const text = parts.map((p) => (p.kind === "text" ? p.value : p.names.join(" "))).join("");
    expect(text).not.toContain("Unreachable: Bomai");
  });
});
