/**
 * REEA-935 — focused pins for the link-smoke checker's new outcome machine
 * (REEA-934 spec §4): challenge-aware checking (R2), transient retry (R3),
 * the per-host identity table (R1) and the per-host pacing floor.
 *
 * The unit under test is the smoke script's exported, injectable core —
 * scripts/dead-link-smoke.mjs exports its pure pieces (identityFor,
 * classifyAttempt, checkUrl, checkQueueWithPacing) and only runs its live
 * main() when executed directly, so these pins drive it with a stubbed fetch
 * and zero/recorded backoffs: no sleeping, no network.
 */
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const checker: any = await import("../../../scripts/dead-link-smoke.mjs");

const OK = { status: 200, headers: new Headers(), bodySnip: "" };

/** Fetch stub answering from a queue; each entry is a status, a Response-like factory, or a thrower. */
function stubFetch(queue: Array<{ status?: number; headers?: Headers; body?: string; throw?: Error }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue[calls.length - 1];
    if (!next) throw new Error("stub queue exhausted");
    if (next.throw) throw next.throw;
    return {
      status: next.status ?? 200,
      headers: next.headers ?? new Headers(),
      text: async () => next.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("REEA-935 classifyAttempt", () => {
  it("maps the outcome vocabulary per the spec", () => {
    expect(checker.classifyAttempt(200, new Headers(), "")).toBe("ok");
    expect(checker.classifyAttempt(302, new Headers(), "")).toBe("ok");
    expect(checker.classifyAttempt(429, new Headers(), "")).toBe("challenge");
    expect(
      checker.classifyAttempt(403, new Headers({ "cf-mitigated": "challenge" }), ""),
    ).toBe("challenge");
    expect(checker.classifyAttempt(403, new Headers(), "<title>Just a moment...</title>")).toBe(
      "challenge",
    );
    expect(checker.classifyAttempt(403, new Headers(), "plain forbidden")).toBe("dead");
    // REEA-1154 — Cloudflare's block page is a bot-wall, not a dead link. The
    // live shape: Talabat's catalog URL answered 403 with `server: cloudflare`
    // and the "Attention Required! | Cloudflare" title, which failed every
    // deploy's link-health gate until the classifier learned it.
    expect(
      checker.classifyAttempt(
        403,
        new Headers({ server: "cloudflare", "cf-ray": "a603109a5f797ccf-KWI" }),
        "",
      ),
    ).toBe("challenge");
    expect(
      checker.classifyAttempt(
        403,
        new Headers(),
        "<title>Attention Required! | Cloudflare</title>",
      ),
    ).toBe("challenge");
    expect(checker.classifyAttempt(404, new Headers(), "")).toBe("dead");
    expect(checker.classifyAttempt(410, new Headers(), "")).toBe("dead");
    expect(checker.classifyAttempt(500, new Headers(), "")).toBe("transient");
    expect(checker.classifyAttempt(503, new Headers(), "")).toBe("transient");
  });

  // REEA-1166 — a Cloudflare BLOCK page (not the JS "Just a moment" challenge)
  // is a bot-wall answer: the edge served it, a shopper browser gets the page.
  // Talabat's /en/kuwait offer URL answers exactly this from the deploy runner,
  // and the gate must not call it dead.
  it("REEA-1166: a CF 403 block page (Attention Required! | Cloudflare) is challenge, not dead", () => {
    expect(
      checker.classifyAttempt(
        403,
        new Headers(),
        '<title>Attention Required! | Cloudflare</title>',
      ),
    ).toBe("challenge");
    expect(
      checker.classifyAttempt(
        403,
        new Headers(),
        '<title>Checking your browser before accessing</title>',
      ),
    ).toBe("challenge");
    // Any cf-mitigated value means Cloudflare intervened ("block" as well as
    // "challenge"); a plain 403 without a mitigation marker stays dead.
    expect(checker.classifyAttempt(403, new Headers({ "cf-mitigated": "block" }), "nope")).toBe(
      "challenge",
    );
  });

  it("REEA-1166: the challenge marker only rescues 403s — real 404/410/5xx stay dead/transient", () => {
    const cf = '<title>Attention Required! | Cloudflare</title>';
    expect(checker.classifyAttempt(404, new Headers(), cf)).toBe("dead");
    expect(checker.classifyAttempt(410, new Headers(), cf)).toBe("dead");
    expect(checker.classifyAttempt(500, new Headers(), cf)).toBe("transient");
  });
});

describe("REEA-935 checkUrl (stubbed fetch, injected backoffs)", () => {
  const base = { challengeBackoffMs: 0, transientBackoffMs: 0, sleep: noSleep };

  it("AC-2.1: a 429 that clears on the backoff retry is recorded ok", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 429 }, { status: 200 }]);
    const r = await checker.checkUrl(fetchImpl, "https://wibi.com.kw/p/1", base);
    expect(r).toEqual({ outcome: "ok", attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it("AC-2.2: a challenge persisting across both attempts is `challenge`, not dead", async () => {
    const { fetchImpl } = stubFetch([{ status: 429 }, { status: 429 }]);
    const r = await checker.checkUrl(fetchImpl, "https://wibi.com.kw/p/1", base);
    expect(r).toEqual({ outcome: "challenge", attempts: 2 });
  });

  it("a CF challenge 403 (header or body marker) rides the challenge path", async () => {
    const hdr = await checker.checkUrl(
      stubFetch([{ status: 403, headers: new Headers({ "cf-mitigated": "challenge" }) }, OK]).fetchImpl,
      "https://blink.com.kw/p/1",
      base,
    );
    expect(hdr.outcome).toBe("ok");
    const body = await checker.checkUrl(
      stubFetch([{ status: 403, body: "Just a moment" }, { status: 403, body: "Just a moment" }]).fetchImpl,
      "https://blink.com.kw/p/2",
      base,
    );
    expect(body.outcome).toBe("challenge");
  });

  it("a plain 403 is a definitive dead answer with no retry", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 403 }]);
    const r = await checker.checkUrl(fetchImpl, "https://example.com/p/1", base);
    expect(r).toEqual({ outcome: "dead", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("AC-3.1: one timeout then a 200 is ok (the transient retry fired)", async () => {
    const { fetchImpl, calls } = stubFetch([{ throw: new Error("timeout") }, { status: 200 }]);
    const r = await checker.checkUrl(fetchImpl, "https://www.xcite.com/p/1", base);
    expect(r).toEqual({ outcome: "ok", attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it("AC-3.2: a definitive 404 is dead on the single attempt — no extra retry", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 404 }]);
    const r = await checker.checkUrl(fetchImpl, "https://example.com/delisted", base);
    expect(r).toEqual({ outcome: "dead", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("AC-3.3: network error on both attempts is dead, both attempts made", async () => {
    const { fetchImpl, calls } = stubFetch([{ throw: new Error("econn") }, { throw: new Error("econn") }]);
    const r = await checker.checkUrl(fetchImpl, "https://example.com/p/1", base);
    expect(r).toEqual({ outcome: "dead", attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it("a 5xx that clears on the retry is ok; a persistent 5xx is dead", async () => {
    const recovered = await checker.checkUrl(
      stubFetch([{ status: 503 }, { status: 200 }]).fetchImpl,
      "https://example.com/p/1",
      base,
    );
    expect(recovered).toEqual({ outcome: "ok", attempts: 2 });
    const persistent = await checker.checkUrl(
      stubFetch([{ status: 500 }, { status: 500 }]).fetchImpl,
      "https://example.com/p/2",
      base,
    );
    expect(persistent).toEqual({ outcome: "dead", attempts: 2 });
  });

  it("R1: the request rides the per-host identity table's headers", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    await checker.checkUrl(fetchImpl, "https://www.amazon.eg/dp/B0X", base);
    expect(calls[0].init?.headers).toEqual({
      "user-agent": "Mozilla/5.0",
      "accept-encoding": "",
    });
  });
});

describe("REEA-935 identityFor (R1 — no host is checked under a shape our adapters never send)", () => {
  it("amazon.eg gets its adapter's lead shape (REEA-397 pin)", () => {
    expect(checker.identityFor("https://www.amazon.eg/dp/B0X")).toEqual({
      label: "amazon-eg-adapter-lead",
      headers: { "user-agent": "Mozilla/5.0", "accept-encoding": "" },
    });
  });

  it("CF-challenge-zone hosts keep the verified-crawler identity", () => {
    for (const url of [
      "https://www.nextstore.com.kw/catalogsearch/result/?q=x",
      "https://www.luluhypermarket.com/en/p/1",
    ]) {
      const id = checker.identityFor(url);
      expect(id.label).toBe("verified-crawler");
      expect(String(id.headers["user-agent"])).toContain("Googlebot");
    }
  });

  it("every other host gets the honest declared UA (AC-1.4: no global claimed identity)", () => {
    for (const url of [
      "https://www.xcite.com/p/1",
      "https://www.jarir.com/p/1",
      "https://wibi.com.kw/products/x",
      "https://not-a-real-host.invalid/",
    ]) {
      expect(checker.identityFor(url)).toEqual({
        label: "reemco-link-smoke",
        headers: { "user-agent": "reemco-link-smoke/1.0" },
      });
    }
    expect(checker.identityFor("not a url")).toEqual({
      label: "reemco-link-smoke",
      headers: { "user-agent": "reemco-link-smoke/1.0" },
    });
  });
});

describe("REEA-935 checkQueueWithPacing (AC-2.4 — injected clock/timer)", () => {
  it("separates two same-host checks by at least the pause; other hosts do not wait", async () => {
    let clock = 1_000;
    const sleeps: number[] = [];
    const startedAt: number[] = [];
    const deps = {
      pauseMs: 300,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      check: async () => {
        startedAt.push(clock);
        return "ok";
      },
    };
    const items = [
      { merchant: "A", url: "https://a.com/1" },
      { merchant: "A", url: "https://a.com/2" },
      { merchant: "B", url: "https://b.com/1" },
    ];
    const results = await checker.checkQueueWithPacing(items, deps);
    expect(results.map((r: { outcome: string }) => r.outcome)).toEqual(["ok", "ok", "ok"]);
    // second a.com check waited out the 300 ms floor; b.com started immediately after
    expect(sleeps).toEqual([300]);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(300);
    expect(startedAt[2]).toBe(startedAt[1]);
  });

  it("keeps the floor when a check itself takes time (nextAllowedAt anchors on check end)", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const deps = {
      pauseMs: 300,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      check: async () => {
        clock += 50; // each check consumes 50 ms
        return "ok";
      },
    };
    await checker.checkQueueWithPacing(
      [
        { merchant: "A", url: "https://a.com/1" },
        { merchant: "A", url: "https://a.com/2" },
      ],
      deps,
    );
    // after check 1 ends at t=50, the next same-host check may start at t=350
    expect(sleeps).toEqual([300]);
  });
});

describe("REEA-1252 sample selection (the sample is a population slice, not a fixed list)", () => {
  it("rotates a multi-query window across UTC days", () => {
    const pool = ["a", "b", "c", "d", "e", "f"];
    const day1 = checker.selectQueries(Date.UTC(2026, 10, 23, 6), { pool, count: 2 });
    const day2 = checker.selectQueries(Date.UTC(2026, 10, 24, 6), { pool, count: 2 });
    expect(day1).toHaveLength(2);
    expect(day2).toHaveLength(2);
    expect(day1).not.toEqual(day2);
    // Same day is deterministic (a re-run samples the same slice).
    expect(checker.selectQueries(Date.UTC(2026, 10, 23, 22), { pool, count: 2 })).toEqual(day1);
  });

  it("honours an explicit query list (one-off runs/tests)", () => {
    expect(checker.selectQueries(Date.now(), { queries: ["sony", "iphone"] })).toEqual(["sony", "iphone"]);
  });

  it("caps the run and round-robins retailers so one merchant cannot crowd out the rest", () => {
    const perRetailer = new Map([
      ["A", { queue: ["a1", "a2", "a3", "a4"] }],
      ["B", { queue: ["b1", "b2"] }],
    ]);
    const planned = checker.planSample(perRetailer, 3);
    expect(planned).toHaveLength(3);
    expect(planned.map((p: { merchant: string }) => p.merchant)).toEqual(["A", "B", "A"]);
    // The source buckets are not mutated.
    expect(perRetailer.get("A")?.queue).toHaveLength(4);
  });

  it("tops up from the remaining pool when the rotated day plans under the daily floor", async () => {
    const pool = ["q0", "q1", "q2", "q3"];
    const now = Date.UTC(2026, 10, 23, 6);
    // The queries the UTC-day rotation picks for `now` are the thin ones.
    const thin = new Set(checker.selectQueries(now, { pool, count: 2 }));
    const feedCalls: string[] = [];

    const fakeFetch = async (url: string) => {
      const s = String(url);
      if (s.includes("/api/results-followup")) {
        const q = new URL(s).searchParams.get("q") ?? "";
        feedCalls.push(q);
        // Thin categories yield 5 offers; the rest of the pool yields 20.
        const n = thin.has(q) ? 5 : 20;
        return {
          ok: true,
          json: async () => ({
            products: Array.from({ length: n }, (_, i) => ({
              offers: [{ merchant: `M${i % 4}`, url: `https://offer.example/${q}/${i}` }],
            })),
          }),
        };
      }
      return { ok: true, status: 200, headers: new Headers(), text: async () => "" };
    };

    const result = await checker.runDeadLinkSmoke({
      base: "https://smoke.example",
      now,
      queryPool: pool,
      queriesPerRun: 2,
      dailyFloor: 20,
      topUpMaxQueries: 2,
      fetchImpl: fakeFetch,
      sleep: async () => {},
      pauseMs: 0,
      perRetailer: 8,
      maxChecks: 96,
      samplingTimeoutMs: 5000,
    });

    // Two rotated queries plan 10 links; the top-up must draw the rest of the
    // pool until the 20/run floor is met — the week can then reach 320.
    expect(feedCalls.length).toBeGreaterThan(2);
    expect(result.checked).toBeGreaterThanOrEqual(20);
    expect(result.dead).toBe(0);
  });

  it("does not top up when an explicit query list is given (one-off probes stay exact)", async () => {
    const feedCalls: string[] = [];
    const fakeFetch = async (url: string) => {
      const s = String(url);
      if (s.includes("/api/results-followup")) {
        feedCalls.push(s);
        return {
          ok: true,
          json: async () => ({
            products: [{ offers: [{ merchant: "M", url: "https://offer.example/only" }] }],
          }),
        };
      }
      return { ok: true, status: 200, headers: new Headers(), text: async () => "" };
    };

    const result = await checker.runDeadLinkSmoke({
      base: "https://smoke.example",
      queries: ["thin"],
      dailyFloor: 46,
      fetchImpl: fakeFetch,
      sleep: async () => {},
      pauseMs: 0,
      samplingTimeoutMs: 5000,
    });
    expect(feedCalls).toHaveLength(1);
    expect(result.checked).toBe(1);
  });
});
