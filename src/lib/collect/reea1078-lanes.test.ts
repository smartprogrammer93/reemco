/**
 * REEA-1078 S2 — dispatch-level retirement. The policy module is pinned in
 * lane-health.test.ts; this file proves the ONE place that matters: the
 * default fan-out never contacts a retired lane, so
 * `retailer_adapter_attempts["Next Store"]` stops growing and no note (hence
 * no coverage claim) is produced for it. It also pins the dynamic set the
 * caller passes (the 7-day auto-retire output).
 */
import { describe, expect, it } from "vitest";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { DEFAULT_RETIRED_LANES } from "@/lib/collect/lane-health";

/** Every URL the fan-out contacted, in call order. */
function recordingFetch(urls: string[]) {
  return (async (url: string) => {
    urls.push(String(url));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("dead-lane retirement at dispatch (REEA-1078 S2)", () => {
  it("never contacts Next Store — it is retired at the code level", async () => {
    const urls: string[] = [];
    const staged = collectLiveResultsStaged("iphone 17", {
      fetchImpl: recordingFetch(urls),
      country: "KW",
      deadlineMs: 60,
    });
    await staged.allSettled;
    expect(DEFAULT_RETIRED_LANES).toContain("Next Store");
    expect(urls.some((u) => u.includes("nextstore.com.kw"))).toBe(false);
  });

  it("never emits a Next Store note, so no surface can claim its coverage", async () => {
    const urls: string[] = [];
    const staged = collectLiveResultsStaged("iphone 17", {
      fetchImpl: recordingFetch(urls),
      country: "KW",
      deadlineMs: 60,
    });
    const snap = await staged.final;
    expect(snap.notes.map((n) => n.merchant)).not.toContain("Next Store");
    expect(snap.responders?.queried ?? []).not.toContain("Next Store");
  });

  it("honours the dynamic retired set (7-day auto-retire output) as well", async () => {
    const urls: string[] = [];
    const staged = collectLiveResultsStaged("iphone 17", {
      fetchImpl: recordingFetch(urls),
      country: "KW",
      deadlineMs: 60,
      retiredLanes: ["Xcite"],
    });
    await staged.allSettled;
    expect(urls.some((u) => u.includes("xcite.com"))).toBe(false);
    // A lane that is not retired is still contacted (the filter is not a
    // blanket skip): Blink answers through its suggest hop.
    expect(urls.some((u) => u.includes("blink.com.kw"))).toBe(true);
  });
});
