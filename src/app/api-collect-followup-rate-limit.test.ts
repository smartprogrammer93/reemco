/**
 * REEA-1063 — rate-limit gates on the two most expensive unauthenticated
 * routes: POST /api/products/:id/collect and GET /api/results-followup.
 *
 * Mirrors the REEA-782 / REEA-613 echo gating pins: under-budget requests
 * reach the expensive path, a drained bucket answers 429 with the REEA-837
 * wire headers (X-RateLimit-Limit / Remaining, Retry-After) and performs ZERO
 * collection / fan-out work. The "ungated handler" failure mode is pinned by
 * the counters: without the gate every denied request would still create a
 * job and/or start a live collection, so these assertions fail on the
 * pre-REEA-1063 handlers and pass only with the gate in front.
 *
 * The handlers are exercised as plain Request handlers (no Next runtime
 * needed); `after()` is captured and driven manually so the scheduled
 * fan-out is observable, and the expensive collaborators are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startCollection: vi.fn(),
  runCollection: vi.fn(),
  resolveProductIdentity: vi.fn(),
  collectLiveResultsStaged: vi.fn(),
  // REEA-1133 — the follow-up route's cross-worker fallback now takes the
  // page-path admission gate; delegate to the same staged stub so the call
  // counters below still observe exactly one fan-out.
  collectLiveResultsStagedAdmitted: vi.fn(),
  followUpSnapshot: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    mocks.afterTasks.push(task);
  },
}));

vi.mock("@/lib/product-identity", () => ({
  resolveProductIdentity: mocks.resolveProductIdentity,
}));

vi.mock("@/lib/collect/runner", () => ({
  startCollection: mocks.startCollection,
  runCollection: mocks.runCollection,
}));

vi.mock("@/lib/collect/live-search", () => ({
  collectLiveResultsStaged: mocks.collectLiveResultsStaged,
  collectLiveResultsStagedAdmitted: mocks.collectLiveResultsStagedAdmitted,
  followUpSnapshot: mocks.followUpSnapshot,
  FOLLOW_UP_WAIT_MS: 50,
}));

const { resetRateLimiter, checkRateLimit } = await import("@/lib/rate-limit");
const { POST, COLLECT_RATE_LIMIT } = await import("@/app/api/products/[productId]/collect/route");
const { GET, FOLLOWUP_RATE_LIMIT } = await import("@/app/api/results-followup/route");

const PROBE_IP = "203.0.113.9";
const OTHER_IP = "198.51.100.4";

function collectReq(ip: string, body: unknown = {}): Request {
  return new Request("http://localhost/api/products/probe-1/collect", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: JSON.stringify(body),
  });
}

function collectCtx(productId = "probe-1") {
  return { params: Promise.resolve({ productId }) } as never;
}

function followupReq(ip: string, q = "sony"): Request {
  return new Request(`http://localhost/api/results-followup?q=${encodeURIComponent(q)}`, {
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  });
}

function job() {
  return {
    jobId: "job-reea1063",
    productId: "probe-1",
    status: "collecting",
    mode: "live",
    startedAt: new Date().toISOString(),
    subtasks: [],
    offers: [],
  };
}

function liveResult() {
  return { products: [{ id: "sony" }], notes: [], coverage: [] };
}

/** Drive the fan-out the route scheduled through `after()` (Next runs it
 *  after the response; here we run it explicitly so its call count is real). */
async function runAfterTasks(): Promise<void> {
  for (const task of mocks.afterTasks.splice(0)) await task();
}

beforeEach(() => {
  resetRateLimiter();
  mocks.afterTasks.length = 0;
  mocks.startCollection.mockReset();
  mocks.runCollection.mockReset();
  mocks.resolveProductIdentity.mockReset();
  mocks.collectLiveResultsStaged.mockReset();
  mocks.collectLiveResultsStagedAdmitted.mockReset();
  mocks.collectLiveResultsStagedAdmitted.mockImplementation(async (q: string, o: unknown) =>
    mocks.collectLiveResultsStaged(q, o),
  );
  mocks.followUpSnapshot.mockReset();
  mocks.resolveProductIdentity.mockResolvedValue({
    productId: "probe-1",
    title: "Probe Product",
    brand: "Test",
    offers: [
      { merchant: "Alpha", price: 10, currency: "KWD", url: "https://alpha.example/p/1", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  });
  mocks.startCollection.mockResolvedValue({ job: job(), deduped: false, servedFromCache: false });
  mocks.runCollection.mockResolvedValue(job());
  mocks.collectLiveResultsStaged.mockReturnValue({ final: Promise.resolve(liveResult()) });
  mocks.followUpSnapshot.mockReturnValue(Promise.resolve(liveResult()));
});

describe("REEA-1063 POST /api/products/:id/collect rate limit", () => {
  it("under-budget caller reaches the collection path and sees the budget headers", async () => {
    const res = await POST(collectReq(PROBE_IP), collectCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe("job-reea1063");
    // The expensive path ran: one job created, one fan-out scheduled.
    expect(mocks.startCollection).toHaveBeenCalledTimes(1);
    expect(mocks.afterTasks).toHaveLength(1);
    await runAfterTasks();
    expect(mocks.runCollection).toHaveBeenCalledTimes(1);
    // REEA-837 wire shape: the budget is observable before it trips.
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(COLLECT_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(COLLECT_RATE_LIMIT.limit - 1));
  });

  it("drained bucket -> 429 + error body + headers + ZERO collection work", async () => {
    const now = Date.now();
    for (let i = 0; i < COLLECT_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`collect:${PROBE_IP}`, now, COLLECT_RATE_LIMIT);
    }
    const res = await POST(collectReq(PROBE_IP), collectCtx());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(COLLECT_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Ungated-handler regression: no identity walk, no job, no fan-out.
    expect(mocks.resolveProductIdentity).not.toHaveBeenCalled();
    expect(mocks.startCollection).not.toHaveBeenCalled();
    expect(mocks.afterTasks).toHaveLength(0);
    await runAfterTasks();
    expect(mocks.runCollection).not.toHaveBeenCalled();
  });

  it("force:true does not bypass the budget — a forced POST past the limit is 429", async () => {
    const now = Date.now();
    for (let i = 0; i < COLLECT_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`collect:${PROBE_IP}`, now, COLLECT_RATE_LIMIT);
    }
    const res = await POST(collectReq(PROBE_IP, { force: true }), collectCtx());
    expect(res.status).toBe(429);
    expect(mocks.startCollection).not.toHaveBeenCalled();
  });

  it("per-caller isolation: a drained caller is 429 while a fresh caller is 200", async () => {
    const now = Date.now();
    for (let i = 0; i < COLLECT_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`collect:${PROBE_IP}`, now, COLLECT_RATE_LIMIT);
    }
    const drained = await POST(collectReq(PROBE_IP), collectCtx());
    expect(drained.status).toBe(429);
    const fresh = await POST(collectReq(OTHER_IP), collectCtx());
    expect(fresh.status).toBe(200);
    expect(mocks.startCollection).toHaveBeenCalledTimes(1);
  });
});

describe("REEA-1063 GET /api/results-followup rate limit", () => {
  it("under-budget caller gets the converged feed and the budget headers", async () => {
    const res = await GET(followupReq(PROBE_IP));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: unknown[] };
    expect(body.products).toHaveLength(1);
    // Same-worker fast path: no second fan-out, the page's own run is awaited.
    expect(mocks.collectLiveResultsStaged).not.toHaveBeenCalled();
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(FOLLOWUP_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(FOLLOWUP_RATE_LIMIT.limit - 1));
  });

  it("cross-worker path re-collects live once under budget", async () => {
    mocks.followUpSnapshot
      .mockReturnValueOnce(null) // no same-worker run registered
      .mockReturnValueOnce(Promise.resolve(liveResult())); // the re-collected run
    const res = await GET(followupReq(PROBE_IP));
    expect(res.status).toBe(200);
    expect(mocks.collectLiveResultsStaged).toHaveBeenCalledTimes(1);
  });

  it("drained bucket -> 429 + error body + headers + ZERO live collection", async () => {
    const now = Date.now();
    for (let i = 0; i < FOLLOWUP_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`results-followup:${PROBE_IP}`, now, FOLLOWUP_RATE_LIMIT);
    }
    const res = await GET(followupReq(PROBE_IP));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(FOLLOWUP_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Ungated-handler regression: the cross-worker fan-out never starts.
    expect(mocks.followUpSnapshot).not.toHaveBeenCalled();
    expect(mocks.collectLiveResultsStaged).not.toHaveBeenCalled();
  });

  it("per-caller isolation: a drained caller is 429 while a fresh caller is 200", async () => {
    const now = Date.now();
    for (let i = 0; i < FOLLOWUP_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`results-followup:${PROBE_IP}`, now, FOLLOWUP_RATE_LIMIT);
    }
    const drained = await GET(followupReq(PROBE_IP));
    expect(drained.status).toBe(429);
    const fresh = await GET(followupReq(OTHER_IP));
    expect(fresh.status).toBe(200);
  });
});
