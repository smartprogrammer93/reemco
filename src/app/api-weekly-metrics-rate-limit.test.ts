/**
 * REEA-1134 F5 — GET /api/metrics/weekly rate-limit gate regression pins.
 *
 * The weekly snapshot was the last API route with no caller budget (REEA-1121
 * finding F5). It now rides the same REEA-827 shared fixed-window gate as its
 * siblings, with the REEA-1063 placement: the gate answers BEFORE the store
 * reads. Pins, mirroring src/app/api-collect-followup-rate-limit.test.ts:
 *
 *  - under-budget caller gets the PM snapshot and the REEA-837 budget headers;
 *  - a drained bucket answers 429 with the wire headers and performs ZERO
 *    counter/funnel reads (the ungated-handler failure mode: without the gate
 *    every denied request would still read the shared KV twice);
 *  - per-caller isolation — one drained caller does not lock out another;
 *  - the REEA-996 store-unreachable 503 keeps its Retry-After and still carries
 *    the budget headers, so a gated error answer is not mistaken for a denial.
 *
 * The route is exercised as a plain Request handler (no Next runtime needed);
 * the two store reads are mocked so their call count is observable. KV is
 * unbound here (empty env), so `checkRateLimitShared` degrades to the REEA-37
 * per-process window — the same bucket the tests pre-fill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const mocks = vi.hoisted(() => ({
  readWeeklyCountersDetailed: vi.fn(),
  readEvents: vi.fn(),
}));

vi.mock("@/lib/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics")>();
  return { ...actual, readWeeklyCountersDetailed: mocks.readWeeklyCountersDetailed };
});

vi.mock("@/lib/event-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/event-store")>();
  return { ...actual, readEvents: mocks.readEvents };
});

const { resetRateLimiter, checkRateLimit } = await import("@/lib/rate-limit");
const { GET, WEEKLY_METRICS_RATE_LIMIT } = await import("@/app/api/metrics/weekly/route");

const PROBE_IP = "203.0.113.9";
const OTHER_IP = "198.51.100.4";

function weeklyReq(ip: string): Request {
  return new Request("http://localhost/api/metrics/weekly?weeks=4", {
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  });
}

beforeEach(() => {
  resetRateLimiter();
  mocks.readWeeklyCountersDetailed.mockReset();
  mocks.readEvents.mockReset();
  mocks.readWeeklyCountersDetailed.mockResolvedValue({ weeks: {}, source: "local", kvReadFailed: false });
  mocks.readEvents.mockResolvedValue([]);
});

describe("REEA-1134 F5 GET /api/metrics/weekly rate limit", () => {
  it("under-budget caller gets the snapshot and the budget headers", async () => {
    const res = await GET(weeklyReq(PROBE_IP));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The reads ran: the gate does not short-circuit a fresh caller.
    expect(mocks.readWeeklyCountersDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.readEvents).toHaveBeenCalledTimes(1);
    // REEA-837 wire shape: the budget is observable before it trips.
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(WEEKLY_METRICS_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(WEEKLY_METRICS_RATE_LIMIT.limit - 1));
  });

  it("drained bucket -> 429 + error body + headers + ZERO store reads", async () => {
    const now = Date.now();
    for (let i = 0; i < WEEKLY_METRICS_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`metrics-weekly:${PROBE_IP}`, now, WEEKLY_METRICS_RATE_LIMIT);
    }
    const res = await GET(weeklyReq(PROBE_IP));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(WEEKLY_METRICS_RATE_LIMIT.limit));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Ungated-handler regression: the denied request never reached the store.
    expect(mocks.readWeeklyCountersDetailed).not.toHaveBeenCalled();
    expect(mocks.readEvents).not.toHaveBeenCalled();
  });

  it("per-caller isolation: a drained caller is 429 while a fresh caller is 200", async () => {
    const now = Date.now();
    for (let i = 0; i < WEEKLY_METRICS_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(`metrics-weekly:${PROBE_IP}`, now, WEEKLY_METRICS_RATE_LIMIT);
    }
    const drained = await GET(weeklyReq(PROBE_IP));
    expect(drained.status).toBe(429);
    const fresh = await GET(weeklyReq(OTHER_IP));
    expect(fresh.status).toBe(200);
    expect(mocks.readWeeklyCountersDetailed).toHaveBeenCalledTimes(1);
  });

  it("store-unreachable 503 keeps Retry-After and the budget headers", async () => {
    mocks.readWeeklyCountersDetailed.mockResolvedValue({ weeks: {}, source: "local", kvReadFailed: true });
    const res = await GET(weeklyReq(PROBE_IP));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("weekly_metrics_store_unreachable");
    expect(res.headers.get("retry-after")).toBe("5");
    // The gate headers ride the error answer too: a 503 is not a denial.
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(WEEKLY_METRICS_RATE_LIMIT.limit));
  });
});
