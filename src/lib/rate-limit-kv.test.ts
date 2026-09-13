/**
 * REEA-827 — shared-KV fixed-window counter pins.
 *
 * The REEA-37 limiter is per-process; on Vercel the gated endpoints fan out
 * across instances, so the per-caller budget was per caller per instance
 * ([REEA-826](/REEA/issues/REEA-826)). These pins prove the shared layer:
 * a budget drained through the KV counter stays drained no matter which
 * "instance" asks (memory reset does not re-arm it), a new window re-arms,
 * the raw caller IP never reaches KV, and a KV hiccup degrades to the
 * per-process window instead of failing the request. The /api/echo wiring
 * is exercised end-to-end against an Upstash-shaped REST stub so the gate
 * provably answers 429 with ZERO upstream fetches once the SHARED count is
 * spent — the deployment-wide property the per-instance limiter could not
 * give us.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedKv } from "@/lib/collect/kv";
import {
  checkRateLimitShared,
  sharedWindowKey,
  windowIdAt,
  RATE_LIMIT_KV_PREFIX,
} from "@/lib/rate-limit-kv";

const { resetRateLimiter, checkRateLimit, RATE_LIMIT } = await import("@/lib/rate-limit");

/** Fake shared store: the KV contract as a Map, shared by every "instance". */
function fakeKv(opts: { fail?: boolean } = {}): SharedKv & { counts: Map<string, number>; ttls: Map<string, number> } {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    counts,
    ttls,
    async get() {
      return null;
    },
    async set() {
      return true;
    },
    async incr(key, ttlSeconds) {
      if (opts.fail) return null;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      ttls.set(key, ttlSeconds);
      return n;
    },
  };
}

beforeEach(() => {
  resetRateLimiter();
});

describe("REEA-827 shared fixed-window counter", () => {
  it("counts every hit in the shared window: budget drained via KV stays drained", async () => {
    const kv = fakeKv();
    const now = 1_700_000_000_000;
    const opts = { limit: 3, windowMs: 60_000, kv };
    for (let i = 0; i < 3; i += 1) {
      expect((await checkRateLimitShared("echo:203.0.113.9", now, opts)).allowed).toBe(true);
    }
    // The shared count is spent — resetting the per-process layer does NOT
    // re-arm the budget (that is the per-instance blindness being fixed).
    resetRateLimiter();
    const drained = await checkRateLimitShared("echo:203.0.113.9", now, opts);
    expect(drained).toEqual({ allowed: false, remaining: 0 });
    expect(kv.counts.size).toBe(1);
  });

  it("a new fixed window re-arms the budget under a fresh KV key", async () => {
    const kv = fakeKv();
    const opts = { limit: 2, windowMs: 1_000, kv };
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 2; i += 1) {
      await checkRateLimitShared("echo:203.0.113.9", t0, opts);
    }
    expect((await checkRateLimitShared("echo:203.0.113.9", t0, opts)).allowed).toBe(false);
    const next = await checkRateLimitShared("echo:203.0.113.9", t0 + 1_000, opts);
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(1);
    // Two distinct window keys — the window id rides in the key.
    expect(kv.counts.size).toBe(2);
  });

  it("the raw caller IP never reaches KV; namespace + window id stay in the key", async () => {
    const kv = fakeKv();
    const now = 1_700_000_000_000;
    await checkRateLimitShared("echo:203.0.113.9", now, { limit: 5, windowMs: 60_000, kv });
    const [key] = [...kv.counts.keys()];
    expect(key.startsWith(RATE_LIMIT_KV_PREFIX)).toBe(true);
    expect(key).not.toContain("203.0.113.9");
    expect(key.endsWith(`:${windowIdAt(now, 60_000)}`)).toBe(true);
    // Deterministic, and different callers never collide.
    expect(sharedWindowKey("echo:203.0.113.9", windowIdAt(now, 60_000))).toBe(key);
    expect(sharedWindowKey("echo:198.51.100.4", windowIdAt(now, 60_000))).not.toBe(key);
  });

  it("arms a TTL that outlives the window so spent keys garbage-collect", async () => {
    const kv = fakeKv();
    await checkRateLimitShared("echo:203.0.113.9", 1_700_000_000_000, { limit: 5, windowMs: 60_000, kv });
    const [ttl] = [...kv.ttls.values()];
    expect(ttl).toBe(61);
  });

  it("KV hiccup (incr -> null) degrades to the per-process sliding window", async () => {
    const kv = fakeKv({ fail: true });
    const opts = { limit: 2, windowMs: 60_000, kv };
    expect((await checkRateLimitShared("csp-report:203.0.113.9", 1_700_000_000_000, opts)).allowed).toBe(true);
    // Prime the local layer directly, then confirm the fallback answers for it.
    for (let i = 0; i < 2; i += 1) checkRateLimit("csp-report:203.0.113.9", 1_700_000_000_000);
    const drained = await checkRateLimitShared("csp-report:203.0.113.9", 1_700_000_000_000, opts);
    expect(drained.allowed).toBe(false);
    expect(kv.counts.size).toBe(0);
  });

  it("KV throw also degrades to the local layer instead of failing the request", async () => {
    const kv: SharedKv = {
      get: async () => null,
      set: async () => true,
      incr: async () => {
        throw new Error("kv down");
      },
    };
    const res = await checkRateLimitShared("events:203.0.113.9", 1_700_000_000_000, {
      limit: 5,
      windowMs: 60_000,
      kv,
    });
    expect(res.allowed).toBe(true);
  });

  it("no KV binding at all behaves exactly like the REEA-37 limiter", async () => {
    const opts = { limit: 2, windowMs: 60_000, kv: null };
    const now = 1_700_000_000_000;
    await checkRateLimitShared("health:203.0.113.9", now, opts);
    await checkRateLimitShared("health:203.0.113.9", now, opts);
    const viaShared = await checkRateLimitShared("health:203.0.113.9", now, opts);
    const viaMemory = checkRateLimit("health:203.0.113.9", now, { limit: 2, windowMs: 60_000 });
    expect(viaShared.allowed).toBe(false);
    expect(viaMemory.allowed).toBe(false);
  });
});

describe("REEA-827 GET /api/echo rides the shared counter (Upstash-shaped REST stub)", () => {
  const KV_BASE = "https://kv.example/upstash";
  const store = new Map<string, number>();
  let probeCalls = 0;

  const offlineFetch = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
    const u = String(url);
    if (u.startsWith(KV_BASE)) {
      const m = u.slice(KV_BASE.length).match(/^\/(incr|expire)\/([^/]+)(?:\/(\d+))?$/);
      if (!m) return Response.json({ error: "unsupported" }, { status: 400 });
      const key = decodeURIComponent(m[2]);
      if (m[1] === "incr") {
        const n = (store.get(key) ?? 0) + 1;
        store.set(key, n);
        return Response.json({ result: n });
      }
      return Response.json({ result: 1 });
    }
    probeCalls += 1;
    throw new Error("offline probe stub");
  });

  function echoReq(ip: string): Request {
    return new Request("http://localhost/api/echo", {
      headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
    });
  }

  beforeEach(() => {
    store.clear();
    probeCalls = 0;
    resetRateLimiter();
    vi.stubGlobal("fetch", offlineFetch);
    process.env.KV_REST_API_URL = KV_BASE;
    process.env.KV_REST_API_TOKEN = "test-token";
  });

  it("spent SHARED count -> 429 with zero upstream fetches, on a fresh process", async () => {
    const { GET } = await import("@/app/api/echo/route");
    const { checkRateLimitShared: gate } = await import("@/lib/rate-limit-kv");
    // Another instance drained the shared echo bucket for this caller.
    for (let i = 0; i < RATE_LIMIT.limit; i += 1) {
      await gate(`echo:203.0.113.9`, Date.now());
    }
    probeCalls = 0;
    const res = await GET(echoReq("203.0.113.9"));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
    expect(probeCalls).toBe(0);
  });

  it("under-budget caller passes the gate; KV keys carry no raw IP", async () => {
    const { GET } = await import("@/app/api/echo/route");
    const res = await GET(echoReq("198.51.100.4"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkedAt: string };
    expect(body.checkedAt).toBeTruthy();
    expect(probeCalls).toBeGreaterThan(0);
    for (const key of store.keys()) {
      expect(key.startsWith(RATE_LIMIT_KV_PREFIX)).toBe(true);
      expect(key).not.toContain("198.51.100.4");
    }
  });
});
