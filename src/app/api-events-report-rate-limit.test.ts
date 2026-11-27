/**
 * REEA-1251 — GET /api/events/report caller budget + aggregate cache pins.
 *
 * Security follow-up from REEA-1245 (OWASP API4:2023): the public report read
 * had no caller budget and re-read/re-parsed the full anonymous event blob on
 * every call (1.39 s solo, 14.78 s average at 60 concurrent). The fix spec is
 * pinned here:
 *
 *  - the REEA-827 shared fixed window (30/min, the /api/metrics/weekly budget)
 *    answers BEFORE any store read: a drained caller gets 429 + Retry-After
 *    and performs ZERO reads or pruning;
 *  - the aggregate is cached for REPORT_CACHE_TTL_MS and concurrent misses
 *    coalesce on ONE parse (single flight), so a 60-call burst parses the blob
 *    once, not 60 times;
 *  - pruning no longer rides every read: the route claims at most one hourly
 *    slot and schedules the prune through `after()`, after the response;
 *  - `cache-control: no-store` stays on the answer and the payload shape is
 *    unchanged.
 *
 * The handler is exercised as a plain Request handler (no Next runtime); KV is
 * unbound here (empty env) so `checkRateLimitShared` degrades to the REEA-37
 * per-process window the tests pre-fill, and `after()` is captured so the
 * scheduled prune is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunnelEvent } from "@/lib/events";

process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const mocks = vi.hoisted(() => ({
  readEvents: vi.fn(),
  pruneOldEvents: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    mocks.afterTasks.push(task);
  },
}));

vi.mock("@/lib/event-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/event-store")>();
  return { ...actual, readEvents: mocks.readEvents, pruneOldEvents: mocks.pruneOldEvents };
});

const { resetRateLimiter, checkRateLimit } = await import("@/lib/rate-limit");
const { resetReportCache, REPORT_CACHE_TTL_MS, REPORT_PRUNE_INTERVAL_MS } = await import(
  "@/lib/report-cache"
);
const { GET, REPORT_RATE_LIMIT } = await import("@/app/api/events/report/route");

const PROBE_IP = "203.0.113.9";
const OTHER_IP = "198.51.100.4";
/** Fixed wall clock for the fake-timer pins (inside every window used here). */
const BASE_MS = Date.parse("2026-11-27T12:00:00Z");

/** One search + one click inside the default 7-day window. */
const FIXTURE: FunnelEvent[] = [
  { id: "e1", ts: "2026-11-27T10:00:00Z", type: "search_submitted", query: "iphone" },
  { id: "e2", ts: "2026-11-27T10:05:00Z", type: "item_clicked", query: "iphone", rank: 0 },
];

function reportReq(ip: string, days = 7): Request {
  return new Request(`http://localhost/api/events/report?days=${days}`, {
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  });
}

/** Spend a caller's whole budget in the current fixed window. */
function drain(ip: string): void {
  const now = Date.now();
  for (let i = 0; i < REPORT_RATE_LIMIT.limit; i += 1) {
    checkRateLimit(`events-report:${ip}`, now, REPORT_RATE_LIMIT);
  }
}

/** Drive the work the route scheduled through `after()`. */
async function runAfterTasks(): Promise<void> {
  for (const task of mocks.afterTasks.splice(0)) await task();
}

beforeEach(() => {
  resetRateLimiter();
  resetReportCache();
  mocks.afterTasks.length = 0;
  mocks.readEvents.mockReset();
  mocks.pruneOldEvents.mockReset();
  mocks.readEvents.mockResolvedValue(FIXTURE);
  mocks.pruneOldEvents.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("REEA-1251 GET /api/events/report rate limit + aggregate cache", () => {
  it("under-budget caller gets the report, the budget headers and a fresh aggregate", async () => {
    const res = await GET(reportReq(PROBE_IP));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-report-cache")).toBe("miss");
    // REEA-837 wire shape: the budget is observable before it trips.
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(REPORT_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(REPORT_RATE_LIMIT.limit - 1));
    // The gate does not short-circuit a fresh caller.
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { window_days: number; searches: number; click_outs: number; v1: unknown };
    expect(body.window_days).toBe(7);
    expect(body.searches).toBe(1);
    expect(body.click_outs).toBe(1);
    expect(body.v1).toBeTruthy();
    // The first read of a process claims the hourly prune slot; it runs AFTER
    // the answer, never in front of the caller.
    expect(mocks.afterTasks).toHaveLength(1);
    expect(mocks.pruneOldEvents).not.toHaveBeenCalled();
    await runAfterTasks();
    expect(mocks.pruneOldEvents).toHaveBeenCalledTimes(1);
  });

  it("drained bucket -> 429 + Retry-After + headers + ZERO store reads and no prune", async () => {
    drain(PROBE_IP);
    const res = await GET(reportReq(PROBE_IP));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(REPORT_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Ungated-handler regression: a denied request never reaches the blob.
    expect(mocks.readEvents).not.toHaveBeenCalled();
    expect(mocks.pruneOldEvents).not.toHaveBeenCalled();
    expect(mocks.afterTasks).toHaveLength(0);
  });

  it("per-caller isolation: a drained caller is 429 while a fresh caller is 200", async () => {
    drain(PROBE_IP);
    expect((await GET(reportReq(PROBE_IP))).status).toBe(429);
    const fresh = await GET(reportReq(OTHER_IP));
    expect(fresh.status).toBe(200);
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);
  });

  it("repeat read inside the TTL is served from the aggregate cache with no second parse", async () => {
    const first = await GET(reportReq(PROBE_IP));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-report-cache")).toBe("miss");
    const second = await GET(reportReq(PROBE_IP));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-report-cache")).toBe("hit");
    // The expensive path ran exactly once: the second read never re-read the
    // 7.5 MB blob.
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);
    // Same aggregate, byte-identical (including its generated_at).
    expect(await second.json()).toEqual(await first.json());
    // The budget still counts the cached read.
    expect(second.headers.get("X-RateLimit-Remaining")).toBe(String(REPORT_RATE_LIMIT.limit - 2));
  });

  it("concurrent misses coalesce on ONE parse (single flight)", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => GET(reportReq(PROBE_IP))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.headers.get("x-report-cache") === "miss")).toBe(true);
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);
  });

  it("the cache expires after REPORT_CACHE_TTL_MS and re-computes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    resetRateLimiter();
    resetReportCache();

    const first = await GET(reportReq(PROBE_IP));
    expect(first.headers.get("x-report-cache")).toBe("miss");
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REPORT_CACHE_TTL_MS + 1);
    const second = await GET(reportReq(PROBE_IP));
    expect(second.headers.get("x-report-cache")).toBe("miss");
    expect(mocks.readEvents).toHaveBeenCalledTimes(2);
  });

  it("prune runs at most hourly, never per read or per cache miss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    resetRateLimiter();
    resetReportCache();

    // Cold read claims the first hourly slot.
    expect((await GET(reportReq(PROBE_IP))).status).toBe(200);
    expect(mocks.afterTasks).toHaveLength(1);
    // A cache hit does not schedule another prune.
    expect((await GET(reportReq(PROBE_IP))).status).toBe(200);
    expect(mocks.afterTasks).toHaveLength(1);
    // A TTL-expired re-computation inside the same hour still does not.
    vi.advanceTimersByTime(REPORT_CACHE_TTL_MS + 1);
    expect((await GET(reportReq(PROBE_IP))).status).toBe(200);
    expect(mocks.afterTasks).toHaveLength(1);
    // Crossing the hourly interval claims a fresh slot.
    vi.advanceTimersByTime(REPORT_PRUNE_INTERVAL_MS);
    expect((await GET(reportReq(PROBE_IP))).status).toBe(200);
    expect(mocks.afterTasks).toHaveLength(2);

    await runAfterTasks();
    expect(mocks.pruneOldEvents).toHaveBeenCalledTimes(2);
  });

  it("60-concurrent burst: 30 admitted 200 / 30 denied 429 with Retry-After, no 5xx, one parse", async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => GET(reportReq(PROBE_IP))));
    const statuses = results.map((r) => r.status);
    const admitted = results.filter((r) => r.status === 200);
    const denied = results.filter((r) => r.status === 429);
    expect(admitted).toHaveLength(REPORT_RATE_LIMIT.limit);
    expect(denied).toHaveLength(60 - REPORT_RATE_LIMIT.limit);
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    // The success condition's load bound: one blob parse for the whole burst.
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);
    for (const res of admitted) {
      expect(res.headers.get("X-RateLimit-Limit")).toBe(String(REPORT_RATE_LIMIT.limit));
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    for (const res of denied) {
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    }
  });
});
