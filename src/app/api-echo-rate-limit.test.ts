/**
 * REEA-782 — GET /api/echo rate-limit gate regression pins.
 *
 * The route is exercised as a plain Request handler (no Next runtime needed;
 * the handler only reads `req.headers`). Probes are stubbed offline via a
 * counting global fetch — the route's per-probe catch makes an under-budget
 * 200 deterministic — and the shared REEA-37 bucket store is reset per test.
 * Pins: under-budget 200 with the normal probe report, drained-bucket 429
 * with ZERO upstream fetches (fail closed), and per-caller isolation on
 * recovery within the same window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetRateLimiter, RATE_LIMIT } = await import("@/lib/rate-limit");
const { GET } = await import("@/app/api/echo/route");

let fetchCalls = 0;
const offlineFetch = vi.fn(async (): Promise<Response> => {
  fetchCalls += 1;
  throw new Error("offline probe stub");
});

function echoReq(ip: string): Request {
  return new Request("http://localhost/api/echo", {
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  });
}

beforeEach(() => {
  resetRateLimiter();
  fetchCalls = 0;
  vi.stubGlobal("fetch", offlineFetch);
});

describe("REEA-782 GET /api/echo rate limit", () => {
  it("under-budget caller gets 200 with the normal probe report shape", async () => {
    const res = await GET(echoReq("203.0.113.9"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zones: Record<string, unknown>; checkedAt: string };
    // Probes ran (offline stub answered each), report shape intact.
    expect(Object.keys(body.zones).sort()).toEqual([
      "pckuwait.com",
      "www.luluhypermarket.com",
      "www.sultan-center.com",
    ]);
    expect(body.checkedAt).toBeTruthy();
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it("drained echo bucket -> 429 + error body + ZERO upstream fetches", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT.limit; i += 1) {
      checkRateLimit("echo:203.0.113.9", now);
    }
    fetchCalls = 0;
    const res = await GET(echoReq("203.0.113.9"));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
    expect(fetchCalls).toBe(0);
  });

  it("drained caller stays 429 within the window while a different caller is 200", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT.limit; i += 1) {
      checkRateLimit("echo:203.0.113.9", now);
    }
    const drained = await GET(echoReq("203.0.113.9"));
    expect(drained.status).toBe(429);
    // Per-caller isolation: a different key has its own bucket.
    const fresh = await GET(echoReq("198.51.100.4"));
    expect(fresh.status).toBe(200);
  });
});
