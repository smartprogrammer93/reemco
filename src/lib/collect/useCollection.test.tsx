// @vitest-environment jsdom
/**
 * REEA-88 — client hook failure paths.
 *
 * Verifies the cross-instance 404 fallback: when the polling endpoint cannot
 * see the job (serverless warm-instance miss), the hook re-starts the
 * collection exactly once, and surfaces a product-level error state if the
 * job is still unknown (T6). Also covers double-start dedupe (AC8).
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSessionCacheForTests, useCollection } from "@/lib/collect/useCollection";
import type { CollectJob } from "@/lib/collect/types";

type Route =
  | { match: "start"; jobId: string }
  | { match: "job"; status: string }
  | { match: "404" };

let routes: Route[] = [];
let currentJobId = "j1";
const calls: string[] = [];

function respond(route: Route): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  if (route.match === "404") return { ok: false, status: 404, json: async () => ({}) };
  if (route.match === "start") {
    currentJobId = route.jobId;
    return { ok: true, status: 200, json: async () => ({ jobId: route.jobId }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jobId: currentJobId,
      productId: "p1",
      status: route.status,
      mode: "live",
      startedAt: new Date().toISOString(),
      subtasks: [],
      offers: [],
    }),
  };
}

beforeEach(() => {
  resetSessionCacheForTests();
  calls.length = 0;
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(init?.method === "POST" ? `POST ${url}` : `GET ${url}`);
      const route = routes.shift();
      if (!route) throw new Error(`no scripted route for ${calls.at(-1)}`);
      return respond(route);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCollection", () => {
  it("restarts the collection once when the poll 404s, then completes", async () => {
    routes.push(
      { match: "start", jobId: "j1" },
      { match: "404" }, // poll: unknown job on another instance
      { match: "start", jobId: "j2" }, // auto re-start
      { match: "job", status: "complete" },
    );
    const { result } = renderHook(() => useCollection("p1"));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: "terminal",
        job: expect.objectContaining({ jobId: "j2", status: "complete" }),
      }),
    );
    expect(calls).toEqual([
      "POST /api/products/p1/collect",
      "GET /api/collect-jobs/j1",
      "POST /api/products/p1/collect",
      "GET /api/collect-jobs/j2",
    ]);
  });

  it("falls back to synchronous ?wait=1 when polling misses across functions", async () => {
    routes.push(
      { match: "start", jobId: "j1" },
      { match: "404" }, // poll: cross-function miss
      { match: "start", jobId: "j1" }, // restart
      { match: "404" }, // poll miss again — restart budget exhausted
      { match: "job", status: "complete" }, // POST ?wait=1 terminal snapshot
    );
    const { result } = renderHook(() => useCollection("p1"));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: "terminal",
        job: expect.objectContaining({ status: "complete" }),
      }),
    );
    expect(calls.at(-1)).toBe("POST /api/products/p1/collect?wait=1");
  });

  it("surfaces a product-level error when the restart also 404s", async () => {
    routes.push(
      { match: "start", jobId: "j1" },
      { match: "404" },
      { match: "start", jobId: "j1" },
      { match: "404" },
    );
    const { result } = renderHook(() => useCollection("p1"));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: "terminal",
        job: expect.objectContaining({ status: "failed" }),
      }),
    );
    const state = result.current.state;
    if (state.kind !== "terminal") throw new Error("expected terminal");
    expect(state.job.error).toMatch(/not found/i);
  });

  it("dedupes a second start while a collection is active (AC8)", async () => {
    routes.push({ match: "start", jobId: "j1" }, { match: "job", status: "collecting" });
    const { result } = renderHook(() => useCollection("p1"));
    const first = act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.start(); // double-click while busy
    });
    await first;
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });
});

describe("useCollection attach path (REEA-248)", () => {
  const offer = {
    merchant: "Alpha",
    domain: "alpha.example",
    price: 11.5,
    currency: "KWD",
    url: "https://alpha.example/p/1",
    inStock: true,
    collectedAt: "2026-01-01T00:00:00.000Z",
    method: "live" as const,
  };

  it("continues a server-started job by polling only — no POST on mount", async () => {
    const seeded: CollectJob = {
      jobId: "j9",
      productId: "p1",
      status: "collecting",
      mode: "live",
      startedAt: new Date().toISOString(),
      subtasks: [],
      offers: [offer],
    };
    routes.push({ match: "job", status: "complete" });
    const { result } = renderHook(() => useCollection("p1", seeded));
    // First paint already shows the server snapshot (initializer seed).
    expect(result.current.state).toEqual({ kind: "polling", job: seeded });
    // Hydration mirrors CollectionPanel's mount effect: attach to the job —
    // polling continues it to convergence with no re-POST (AC2).
    await act(async () => {
      result.current.attach(seeded);
    });
    await waitFor(() => expect(result.current.state.kind).toBe("terminal"));
    expect(calls).toEqual(["GET /api/collect-jobs/j9"]);
  });

  it("renders a server-completed snapshot with zero fetches", async () => {
    const done: CollectJob = {
      jobId: "j10",
      productId: "p2",
      status: "complete",
      mode: "live",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      subtasks: [],
      offers: [offer],
    };
    const { result } = renderHook(() => useCollection("p2", done));
    await act(async () => {
      result.current.attach(done); // hydration-time attach: snapshot is final
    });
    expect(result.current.state).toEqual({ kind: "terminal", job: done });
    expect(calls).toEqual([]);
  });

  it("keeps the labeled-repeat revalidation when a same-tab snapshot exists", async () => {
    const done: CollectJob = {
      jobId: "j11",
      productId: "p3",
      status: "complete",
      mode: "live",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      subtasks: [],
      offers: [offer],
    };
    // First visit: attaching a completed job fills the same-tab snapshot.
    const firstVisit = renderHook(() => useCollection("p3", done));
    await act(async () => {
      firstVisit.result.current.attach(done);
    });
    cleanup();
    // Repeat visit with a server snapshot too: existing REEA-95 repeat wins —
    // the cached snapshot renders and a background POST revalidates.
    const seeded: CollectJob = { ...done, jobId: "j12", status: "collecting" };
    routes.push({ match: "start", jobId: "j13" }, { match: "job", status: "collecting" });
    const { result } = renderHook(() => useCollection("p3", seeded));
    await act(async () => {
      result.current.attach(seeded);
    });
    // The cached snapshot renders labeled and the background POST revalidates;
    // the label only clears when a FRESH collection lands (still collecting).
    expect(result.current.cachedNoticeAt).toBe(done.finishedAt ?? null);
    expect(calls[0]).toBe("POST /api/products/p3/collect");
  });
});
