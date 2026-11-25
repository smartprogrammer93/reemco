/**
 * REEA-1154 D4 — the follow-up feed answers a cold worker from the shared
 * layer while the mirrored answer is still inside the memo's fresh window,
 * instead of paying a second fan-out that can settle a different set for the
 * same dispatched query.
 *
 * QA's measured defect this pins: `fold 7` folded in 5 results / 13 offers
 * while `fold7` folded in 10 / 28 — one dispatch, two answers, because the
 * follow-up landed on a worker that never saw the page's run. The shared
 * answer (REEA-602 mirror) is this dispatch's live answer for the window, so
 * the feed must serve it verbatim and never start a fan-out. Past the window
 * it must NOT: the live path runs, so an aged shelf is never passed off as a
 * fresh answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SHARED = {
  products: [
    { productId: "samsung-galaxy-z-fold7", title: "Samsung Galaxy Z Fold7, 5G, 12 GB RAM", offers: [] },
  ],
  notes: [],
  responders: [],
  collectedAt: "2026-11-25T12:00:00.000Z",
  collectedAtEpochMs: Date.parse("2026-11-25T12:00:00.000Z"),
  settled: true,
};

const replayFresh = vi.fn();
vi.mock("@/lib/collect/query-layer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/collect/query-layer")>()),
  replayFreshSharedQuerySnapshot: (key: string) => replayFresh(key),
}));

const fanOut = vi.fn();
vi.mock("@/lib/collect/live-search", () => ({
  collectLiveResultsStagedAdmitted: (...args: unknown[]) => fanOut(...args),
  followUpSnapshot: () => null,
  FOLLOW_UP_WAIT_MS: 50,
}));

const { GET } = await import("@/app/api/results-followup/route");

function req(q: string, cookie?: string): Request {
  return new Request(`http://localhost/api/results-followup?q=${encodeURIComponent(q)}`, {
    headers: {
      "accept-language": "en-KW",
      "x-forwarded-for": "203.0.113.7",
      ...(cookie ? { cookie } : {}),
    },
  });
}

describe("REEA-1154 D4 — cross-worker fresh answer for one dispatched query", () => {
  beforeEach(() => {
    replayFresh.mockReset();
    fanOut.mockReset();
  });

  it("serves the mirrored live answer for `fold 7` under the compact dispatch identity", async () => {
    replayFresh.mockResolvedValue(SHARED);
    const res = await GET(req("fold 7"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SHARED);
    // One dispatched query = one memo identity: the spaced spelling reads the
    // same shared key as the tight one.
    expect(replayFresh).toHaveBeenCalledWith("fold7");
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("reads the same shared identity for the Arabic spelling (locale never forks it)", async () => {
    replayFresh.mockResolvedValue(SHARED);
    const res = await GET(req("فولد 7", "rc_locale=ar"));
    expect(res.status).toBe(200);
    expect(replayFresh).toHaveBeenCalledWith("fold7");
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("falls through to the live fan-out when the mirror is aged or missing", async () => {
    replayFresh.mockResolvedValue(null);
    fanOut.mockResolvedValue({ final: Promise.resolve(null) });
    const res = await GET(req("fold7"));
    // No live answer in time: the page keeps what it rendered.
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(fanOut).toHaveBeenCalledTimes(1);
  });
});
