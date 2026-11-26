/**
 * REEA-1078 S2 — dispatch-level retirement. The policy module is pinned in
 * lane-health.test.ts; this file proves the ONE place that matters: a lane the
 * caller retires is never contacted, so its attempt counter stops growing and
 * no note is produced for it. REEA-1221 emptied the code-level list, so the
 * default fan-out now dispatches every declared adapter — including Next
 * Store, which the browser tier re-admitted.
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
  it("dispatches Next Store — no lane is retired at the code level", async () => {
    const urls: string[] = [];
    const staged = collectLiveResultsStaged("iphone 17", {
      fetchImpl: recordingFetch(urls),
      country: "KW",
      deadlineMs: 2000,
    });
    await staged.allSettled;
    expect(DEFAULT_RETIRED_LANES).toEqual([]);
    expect(urls.some((u) => u.includes("nextstore.com.kw"))).toBe(true);
  });

  it("counts a Next Store hop that never painted the grid as a blocked failure, not a zero", async () => {
    // The browser tier is off in tests, so the "{}"-answering fake leaves the
    // lane with no grid: that must read as a coverage loss with a named cause
    // (REEA-1207 AC 7B-3), never as a silent zero.
    const urls: string[] = [];
    const staged = collectLiveResultsStaged("iphone 17", {
      fetchImpl: recordingFetch(urls),
      country: "KW",
      deadlineMs: 2000,
    });
    const snap = await staged.final;
    const note = snap.notes.find((n) => n.merchant === "Next Store");
    expect(note).toBeDefined();
    expect(note?.hits).toBe(0);
    expect(note?.error).toMatch(/^blocked: no usable payload/);
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
