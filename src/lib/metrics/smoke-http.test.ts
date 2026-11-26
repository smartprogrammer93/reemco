/**
 * REEA-1184 — pins for the deploy gate's throttle-aware HTTP policy.
 *
 * The bug this closes: scripts/smoke-check.mjs treated any non-200 as fatal, so
 * a burst 429 from the app's own per-IP page gate (src/proxy.ts
 * PAGE_RATE_LIMIT, 60/min, REEA-1133) failed step 7 and rolled back three
 * healthy deploys of 641c2b7 (run 45728235136). The build, stamp and headers
 * had all passed; the 429 was the limiter pacing a machine client.
 *
 * The unit under test is scripts/smoke-http.mjs, which exports its pure pieces
 * and takes an injectable fetch/sleep/page so these pins never sleep or hit the
 * network. The static pins at the bottom keep the wiring honest: the smoke must
 * exit 2 (not 1) on throttle exhaustion, and the workflow must rerun the smoke
 * on exit 2 before it rolls the build back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const http: any = await import("../../../scripts/smoke-http.mjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Minimal Response-like object: the policy only reads status + Retry-After. */
function res(status: number, retryAfter?: string) {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return { status, headers };
}

/** Fetch stub answering from a queue and recording every init it was handed. */
function stubFetch(queue: Array<ReturnType<typeof res> | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue[calls.length - 1];
    if (!next) throw new Error("stub queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

describe("REEA-1184 throttle classification", () => {
  it("retries only 429 and 503", () => {
    expect(http.isThrottleStatus(429)).toBe(true);
    expect(http.isThrottleStatus(503)).toBe(true);
    for (const s of [200, 201, 301, 400, 403, 404, 410, 500, 502]) {
      expect(http.isThrottleStatus(s), `status ${s}`).toBe(false);
    }
  });

  it("parses Retry-After delta-seconds and HTTP dates, and rejects garbage", () => {
    expect(http.retryAfterMs(res(429, "15").headers)).toBe(15_000);
    expect(http.retryAfterMs(res(429, " 7 ").headers)).toBe(7_000);
    expect(http.retryAfterMs(res(429, "0").headers)).toBe(0);
    const now = Date.parse("2026-11-26T01:00:00Z");
    expect(http.retryAfterMs(res(429, "Thu, 26 Nov 2026 01:00:30 GMT").headers, now)).toBe(30_000);
    expect(http.retryAfterMs(res(429).headers, now)).toBeNull();
    expect(http.retryAfterMs(res(429, "soon").headers, now)).toBeNull();
  });

  it("honours the served cooldown, caps it, and backs off when it is missing", () => {
    // Served Retry-After wins over backoff.
    expect(http.throttleDelayMs(res(429, "15").headers, 1)).toBe(15_000);
    // Capped so a pathological header cannot stall the gate forever.
    expect(http.throttleDelayMs(res(429, "600").headers, 1)).toBe(30_000);
    // No header: bounded exponential fallback (2s, 4s, 8s...), capped.
    expect(http.throttleDelayMs(res(429).headers, 1)).toBe(2_000);
    expect(http.throttleDelayMs(res(429).headers, 2)).toBe(4_000);
    expect(http.throttleDelayMs(res(429).headers, 6)).toBe(30_000);
  });
});

describe("REEA-1184 fetchWithThrottleRetry", () => {
  it("retries a 429 with the served Retry-After and returns the healthy response", async () => {
    const { fetchImpl, calls } = stubFetch([res(429, "3"), res(200)]);
    const sleeps: number[] = [];
    const out = await http.fetchWithThrottleRetry(
      "https://example.test/results?q=sony",
      () => ({ headers: { accept: "text/html" }, signal: AbortSignal.timeout(1000) }),
      { fetchImpl, sleep: async (ms: number) => sleeps.push(ms), attempts: 3 },
    );
    expect(out.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3_000]);
  });

  it("rebuilds the init for every attempt so a per-attempt timeout signal is fresh", async () => {
    const { fetchImpl, calls } = stubFetch([res(429, "1"), res(429, "1"), res(200)]);
    await http.fetchWithThrottleRetry("https://example.test/results?q=sony", () => ({ signal: AbortSignal.timeout(60_000) }), {
      fetchImpl,
      sleep: async () => {},
      attempts: 3,
    });
    const signals = calls.map((c) => c.init?.signal);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((s) => s && !s.aborted)).toBe(true);
  });

  it("fails fast on a real fault: 500 is returned, not retried", async () => {
    const { fetchImpl, calls } = stubFetch([res(500)]);
    const out = await http.fetchWithThrottleRetry("https://example.test/results?q=sony", {}, { fetchImpl, sleep: async () => {}, attempts: 4 });
    expect(out.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("throws a tagged rate-limited error when every attempt was throttled", async () => {
    const { fetchImpl } = stubFetch([res(429, "5"), res(429, "5"), res(503, "5")]);
    const sleeps: number[] = [];
    await expect(
      http.fetchWithThrottleRetry("https://example.test/results?q=sony", {}, { fetchImpl, sleep: async (ms: number) => sleeps.push(ms), attempts: 3 }),
    ).rejects.toMatchObject({ name: "SmokeThrottledError", rateLimited: true, status: 503, attempts: 3 });
    // 3 attempts -> 2 waits, never a wait after the last attempt.
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("propagates transport errors unchanged (not as a throttle)", async () => {
    const { fetchImpl } = stubFetch([new Error("ECONNRESET")]);
    await expect(http.fetchWithThrottleRetry("https://example.test/", {}, { fetchImpl, sleep: async () => {} })).rejects.toThrow("ECONNRESET");
  });
});

describe("REEA-1184 gotoWithThrottleRetry", () => {
  function stubPage(queue: Array<{ status: number; retryAfter?: string }>) {
    let i = 0;
    return {
      goto: async () => {
        const next = queue[i++];
        const headers = new Headers();
        if (next.retryAfter !== undefined) headers.set("retry-after", next.retryAfter);
        return { status: () => next.status, headers: () => headers };
      },
    };
  }

  it("retries a 429 document navigation and returns the rendered response", async () => {
    const page = stubPage([{ status: 429, retryAfter: "2" }, { status: 200 }]);
    const sleeps: number[] = [];
    const out = await http.gotoWithThrottleRetry(page, "https://example.test/results?q=sony", { waitUntil: "load" }, { sleep: async (ms: number) => sleeps.push(ms), attempts: 3 });
    expect(out.status()).toBe(200);
    expect(sleeps).toEqual([2_000]);
  });

  it("throws the tagged error when the page stays throttled", async () => {
    const page = stubPage([{ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" }]);
    await expect(
      http.gotoWithThrottleRetry(page, "https://example.test/results?q=sony", {}, { sleep: async () => {}, attempts: 2 }),
    ).rejects.toMatchObject({ rateLimited: true, status: 429 });
  });
});

describe("REEA-1184 gate wiring", () => {
  const smoke = readFileSync(path.join(repoRoot, "scripts", "smoke-check.mjs"), "utf8");
  const timings = readFileSync(path.join(repoRoot, "scripts", "smoke-timings.mjs"), "utf8");
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "deploy-selfhosted.yml"), "utf8");

  it("smoke-check retries every app GET through the throttle policy", () => {
    expect(smoke).toContain('from "./smoke-http.mjs"');
    expect(smoke).toContain("fetchWithThrottleRetry");
    expect(smoke).toContain("gotoWithThrottleRetry");
    // The three fatal non-200 sites REEA-1184 named (steps 2, 7, 8) must no
    // longer read a bare fetch/response status as the gate's verdict.
    expect(smoke).not.toMatch(/const resp = await fetch\(/);
    expect(smoke).not.toMatch(/const resp = await page\.goto\(/);
    // Step 5's 375px pass navigates /results and /product too; the REEA-1068
    // sibling fix covered those and the consolidation must not lose them.
    expect(smoke).not.toMatch(/await mobile\.goto\(/);
  });

  it("smoke-check exits 2 (not 1) when the limiter paced every attempt", () => {
    expect(smoke).toMatch(/rateLimited[\s\S]{0,400}process\.exit\(2\)/);
    expect(smoke).toContain("do NOT roll the build back");
  });

  it("the timing probe is throttle-aware too (it spends the page budget first)", () => {
    expect(timings).toContain("fetchWithThrottleRetry");
    expect(timings).toContain("throttled out");
  });

  it("the deploy workflow reruns the smoke on exit 2 before it rolls back", () => {
    const start = workflow.indexOf("name: Funnel smoke check against the new host");
    const end = workflow.indexOf("name: Roll back on external verification failure", start);
    const smokeStep = start === -1 ? "" : workflow.slice(start, end);
    expect(smokeStep).toContain("npm run smoke");
    expect(smokeStep).toContain('if [ "$code" -eq 2 ]');
    expect(smokeStep).toContain("sleep 75");
    // A second run, then a real non-zero exit still rolls back.
    expect((smokeStep.match(/npm run smoke/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(smokeStep).toContain('exit "$code"');
    // The rollback step must still be gated on a successful deploy.
    expect(workflow).toContain("if: failure() && steps.deploy.outcome == 'success'");
  });
});
