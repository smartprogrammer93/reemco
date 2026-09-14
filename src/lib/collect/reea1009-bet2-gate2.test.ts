/**
 * REEA-1009 — bet #2 Gate 2 staging fixture + Gate 1 unit pins (spec v1.0
 * §8, executed against the touched serve surfaces with the flag in BOTH
 * states, because the §9 rollback contract is "flag-off reverts").
 *
 * The AC-7 fixture reproduces exactly the two throw shapes the REEA-995
 * diagnosis says the CF-fronted lanes admit:
 *   (i)   challenge-rotation exhaustion → the `HTTP <lastStatus>` throw
 *         (the 403 interstitial class);
 *   (ii)  the joined-window abort mid-rotation (AbortSignal.timeout →
 *         TimeoutError, "The operation was aborted due to timeout").
 * and asserts, per AC-6a / AC-7(1):
 *   (1) a ceiling-aborted lane settles AT the window with NO second
 *       REEA-290 attempt while the bet #2 flag is on — and the flag OFF
 *       restores the doomed retry exactly as REEA-290 shipped it;
 * per AC-7(2):
 *   (2) clearance-jar behavior — a valid mirrored `cf-clearance:<host>`
 *       entry is REPLAYED on the first attempt (no handshake re-pay), an
 *       expired/absent entry re-pays the handshake once inside the bounded
 *       window, and the Next Store mirror rides the sticky S2 TTL while
 *       every other host keeps the shared 10-minute one;
 * plus the page-structure-integrity assertion (HTTP 200 Magento SSR shape
 * parses unchanged) and the S1b/S2 read-side pins. No new counters anywhere
 * (AC-4): everything here rides injected fetches and stubbed KV.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BET2_CHALLENGE_ROTATION_BUDGET_MS,
  BET2_FLAG_ENV,
  BET2_NEXTSTORE_JAR_TTL_MS,
  BET2_ROTATION_ATTEMPT_MARGIN_MS,
  bet2RotationCanStartAttempt,
} from "@/lib/collect/bet2-flag";
import {
  clearChallengeJarCacheForTests,
  fetchThroughChallenge,
  VERIFIED_BOT_HEADERS,
} from "@/lib/collect/search-fallback";
import {
  collectSettled,
  isWindowAbortError,
  nextStoreHits,
} from "@/lib/collect/live-search";
import { emptyWeek } from "@/lib/metrics";
import { weeklyResponse } from "@/app/api/metrics/weekly/route";
import { classifyEchoError } from "@/app/api/echo/route";

const originalFetch = globalThis.fetch;

/** Real joined-window abort: rejects with the actual TimeoutError the
 *  runtime's AbortSignal.timeout produces — not a hand-mocked shape. */
async function abortWithRealTimeoutError(ms = 5): Promise<never> {
  const signal = AbortSignal.timeout(ms);
  await new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  throw new Error("unreachable");
}

/** Upstash-shaped KV stub: GET answers `getResult`, every SET body recorded. */
function stubKv(getResult: string | null, sets: string[]): void {
  process.env.KV_REST_API_URL = "https://kv.example/";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const method = typeof init?.method === "string" ? init.method : "GET";
    if (method === "GET") {
      return new Response(JSON.stringify({ ok: true, result: getResult }), {
        headers: { "content-type": "application/json" },
      });
    }
    sets.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: true, result: "OK" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const NEXTSTORE_URL = "https://www.nextstore.com.kw/catalogsearch/result/index/?q=iphone%2017";

// Trimmed from the captured live catalogsearch page (2026-09-08, same shape
// the REEA-238 pin uses): Magento SSR card anchor + price-box data amounts.
const MAGENTO_SSR_HTML =
  "<html><body><ul class=\"products list\">" +
  '<li><a class="product-item-link" href="https://www.nextstore.com.kw/iphone-17-pro-256gb.html" title="Apple iPhone 17 Pro 256GB">Apple iPhone 17 Pro 256GB</a>' +
  '<span class="price-box"><span class="price" data-price-amount="389.900" data-price-type="finalPrice">KD 389.900</span></span>' +
  '<a class="product-item-brand" href="/apple">Apple</a></li></ul></body></html>';

beforeEach(() => {
  clearChallengeJarCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  vi.unstubAllEnvs();
});

function flagOn(): void {
  vi.stubEnv(BET2_FLAG_ENV, "on");
}
function flagOff(): void {
  vi.stubEnv(BET2_FLAG_ENV, "");
}

describe("REEA-1009 Gate 2 — AC-7 throw shape (i): challenge-rotation exhaustion", () => {
  it("a zone that answers 403 to every identity exhausts the rotation and throws HTTP 403", async () => {
    flagOn();
    stubKv(null, []);
    let calls = 0;
    const hopFetch = (async () => {
      calls += 1;
      return new Response("challenge", { status: 403 });
    }) as typeof fetch;
    const started = Date.now();
    await expect(fetchThroughChallenge(hopFetch, NEXTSTORE_URL, {}, AbortSignal.timeout(8000))).rejects.toThrow(
      "HTTP 403",
    );
    // All six identities were tried (the pre-bet rotation is preserved); the
    // throw is the exact shape the REEA-995 diagnosis names, and it lands
    // inside the window (the S1a budget can only make it EARLIER, never the
    // ceiling).
    expect(calls).toBe(6);
    expect(Date.now() - started).toBeLessThan(7000);
  });
});

describe("REEA-1009 Gate 2 — AC-7 throw shape (ii): joined-window abort mid-rotation", () => {
  it("a lane whose window aborts mid-rotation rejects with the real TimeoutError and settles AT the window", async () => {
    flagOn();
    stubKv(null, []);
    const hopFetch = (async (_url: string, init?: RequestInit) => {
      // Hang until the caller's own window aborts the hop — the production
      // shape where the challenge rotation never answers in time.
      const signal = init?.signal;
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as typeof fetch;
    const started = Date.now();
    const err = await fetchThroughChallenge(hopFetch, NEXTSTORE_URL, {}, AbortSignal.timeout(250)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    // The honest window-abort shape — NOT an HTTP note — and it settles at
    // the window boundary, not after a doomed extra attempt.
    expect(isWindowAbortError(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("REEA-1009 AC-6a / AC-7(1): the ceiling-aborted lane gets no second attempt", () => {
  /** A collector whose every attempt dies inside `body` (never returns hits). */
  function failingCollector(
    merchant: string,
    body: () => Promise<void>,
  ): Parameters<typeof collectSettled>[0] {
    return {
      merchant,
      country: "KW",
      collect: async () => {
        await body();
        return [];
      },
    };
  }

  it("flag ON: a window-aborted first attempt settles immediately with the abort error — no doomed retry", async () => {
    flagOn();
    let calls = 0;
    const res = await collectSettled(
      failingCollector("Next Store", async () => {
        calls += 1;
        await abortWithRealTimeoutError(5);
      }),
      "iphone 17",
      fetch,
    );
    // The guardrail pin: ONE attempt, settled at the window, error carried —
    // the REEA-290 retry would re-enter an already-spent window.
    expect(calls).toBe(1);
    expect(res.error).toMatch(/abort/i);
    expect(res.hits).toEqual([]);
  });

  it("flag OFF: the REEA-290 second attempt is back exactly as shipped (rollback contract)", async () => {
    flagOff();
    let calls = 0;
    const res = await collectSettled(
      failingCollector("Next Store", async () => {
        calls += 1;
        await abortWithRealTimeoutError(5);
      }),
      "iphone 17",
      fetch,
    );
    expect(calls).toBe(2);
    expect(res.error).toMatch(/abort/i);
  });

  it("flag ON keeps the REEA-290 blip insurance for NON-abort failures (HTTP 503 class)", async () => {
    flagOn();
    let calls = 0;
    const res = await collectSettled(
      failingCollector("Blink", async () => {
        calls += 1;
        throw new Error("blink search HTTP 503");
      }),
      "iphone 17",
      fetch,
    );
    // A blip is still retried once — only the window-abort class is skipped.
    expect(calls).toBe(2);
    expect(res.error).toBe("blink search HTTP 503");
  });
});

describe("REEA-1009 AC-7(2): clearance-jar replay vs re-pay (S2 KV-mirror TTL)", () => {
  it("replays a valid mirrored cf-clearance entry on the FIRST attempt — no handshake re-pay — and re-mirrors with the sticky TTL", async () => {
    flagOn();
    const mirrored = JSON.stringify({ header: "__cf_bm=mirrored", expiresAt: Date.now() + 60_000 });
    const sets: string[] = [];
    stubKv(mirrored, sets);
    const seen: Array<string | null> = [];
    const hopFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie"));
      return new Response(MAGENTO_SSR_HTML);
    }) as typeof fetch;
    const res = await fetchThroughChallenge(hopFetch, NEXTSTORE_URL, {}, AbortSignal.timeout(8000));
    expect(res.status).toBe(200);
    // Cold process Map + warm KV mirror: exactly ONE hop, already carrying
    // the mirrored clearance — the recycled-instance case that produced the
    // 32.2% failure share.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("__cf_bm=mirrored");
    // The replayed jar is re-mirrored before the hop returns, with the S2
    // sticky TTL (30 min = EX 1800) so the NEXT recycled instance inherits it.
    expect(sets.join("\n")).toContain("__cf_bm=mirrored");
    expect(sets.join("\n")).toContain(`EX\n${Math.ceil(BET2_NEXTSTORE_JAR_TTL_MS / 1000)}`);
  });

  it("an absent mirror re-pays the handshake ONCE inside the bounded window, then mirrors the cleared jar", async () => {
    flagOn();
    const sets: string[] = [];
    stubKv(null, sets);
    let calls = 0;
    const hopFetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // First (uncleared) attempt: the CF interstitial, seeding a cookie.
        return new Response("challenge", { status: 403, headers: { "set-cookie": "__cf_bm=hand42; Path=/" } });
      }
      return new Response(MAGENTO_SSR_HTML);
    }) as typeof fetch;
    const res = await fetchThroughChallenge(hopFetch, NEXTSTORE_URL, {}, AbortSignal.timeout(8000));
    expect(res.status).toBe(200);
    // Re-paid exactly once (challenge attempt + cleared attempt) and the
    // freshly cleared jar reached the shared store for the next instance.
    expect(calls).toBe(2);
    expect(sets.join("\n")).toContain("__cf_bm=hand42");
  });

  it("the sticky TTL is Next Store-only: every other host keeps the shared 10-minute mirror", async () => {
    flagOn();
    const sets: string[] = [];
    stubKv(null, sets);
    const hopFetch = (async () =>
      new Response("<html>ok</html>", { headers: { "set-cookie": "__cf_bm=sticky; Path=/" } })) as typeof fetch;
    await fetchThroughChallenge(hopFetch, "https://www.luluhypermarket.com/en/search?query=rice", {}, AbortSignal.timeout(8000));
    expect(sets.join("\n")).toContain("__cf_bm=sticky");
    expect(sets.join("\n")).toMatch(/EX\n600/);
  });

  it("flag OFF: Next Store reverts to the shared 10-minute mirror (rollback contract)", async () => {
    flagOff();
    const sets: string[] = [];
    stubKv(null, sets);
    const hopFetch = (async () =>
      new Response(MAGENTO_SSR_HTML, { headers: { "set-cookie": "__cf_bm=sticky; Path=/" } })) as typeof fetch;
    await fetchThroughChallenge(hopFetch, NEXTSTORE_URL, {}, AbortSignal.timeout(8000));
    expect(sets.join("\n")).toContain("__cf_bm=sticky");
    expect(sets.join("\n")).toMatch(/EX\n600/);
  });
});

describe("REEA-1009 AC-7: page-structure integrity (HTTP 200 Magento SSR shape, unchanged)", () => {
  it("the 200 Magento SSR document still parses into Next Store hits through the real handshake", async () => {
    flagOn();
    stubKv(null, []);
    const hopFetch = (async (_url: string, init?: RequestInit) => {
      // The handshake identity leads, exactly as deployed.
      expect(new Headers(init?.headers).get("user-agent")).toBe(VERIFIED_BOT_HEADERS["user-agent"]);
      return new Response(MAGENTO_SSR_HTML);
    }) as typeof fetch;
    const res = await fetchThroughChallenge(hopFetch, NEXTSTORE_URL, {}, AbortSignal.timeout(8000));
    expect(res.status).toBe(200);
    const html = await res.text();
    const hits = nextStoreHits(html, "iphone 17 pro");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Next Store",
      brand: "Apple",
      price: 389.9,
      currency: "KWD",
      url: "https://www.nextstore.com.kw/iphone-17-pro-256gb.html",
      inStock: true,
    });
  });
});

describe("REEA-1009 S1a constants and the rotation-budget boundary", () => {
  it("the rotation budget finishes inside the 8 s joined window with margin", () => {
    // Joined hop ceiling = RESULTS_COMPLETION_BUDGET_MS (1800) + STAGE_TAIL_HEADROOM_MS (6200) = 8000.
    expect(BET2_CHALLENGE_ROTATION_BUDGET_MS).toBeLessThan(8000);
    expect(8000 - BET2_CHALLENGE_ROTATION_BUDGET_MS).toBeGreaterThanOrEqual(1000);
  });

  it("an attempt is started only when the budget still carries pause + answer margin", () => {
    expect(bet2RotationCanStartAttempt(0, BET2_CHALLENGE_ROTATION_BUDGET_MS)).toBe(true);
    // Exactly the boundary is still affordable (250 pause + 400 margin).
    expect(bet2RotationCanStartAttempt(BET2_CHALLENGE_ROTATION_BUDGET_MS - 250 - BET2_ROTATION_ATTEMPT_MARGIN_MS, BET2_CHALLENGE_ROTATION_BUDGET_MS)).toBe(true);
    // One ms later it is not — starting it would burn the window for nothing.
    expect(bet2RotationCanStartAttempt(BET2_CHALLENGE_ROTATION_BUDGET_MS - 250 - BET2_ROTATION_ATTEMPT_MARGIN_MS + 1, BET2_CHALLENGE_ROTATION_BUDGET_MS)).toBe(false);
    // Flag OFF rides Infinity: the pre-bet loop never budget-breaks.
    expect(bet2RotationCanStartAttempt(Number.MAX_SAFE_INTEGER, Infinity)).toBe(true);
  });
});

describe("REEA-1009 S1b: the weekly read carries the metric-honesty note (flag-gated)", () => {
  const read = { weeks: { "2026-W38": emptyWeek() }, source: "kv" as const, kvReadFailed: false };

  it("flag ON: the payload states the 8.5 s recording cap, the band-interpolated p90 and the shopper-visible targets", async () => {
    flagOn();
    const res = weeklyResponse(read, {}, 8);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      methodology?: Record<string, string>;
      weeks: Record<string, unknown>;
    };
    expect(body.methodology).toBeTruthy();
    expect(body.methodology!.latency_band_clock).toContain("8.5");
    expect(body.methodology!.latency_band_clock).toContain("1800");
    expect(body.methodology!.p90).toContain("band-interpolated");
    expect(body.methodology!.shopper_visible_targets).toContain("2.0");
    // The counters themselves are untouched — reporting text only (AC-4).
    expect(body.weeks["2026-W38"]).toHaveProperty("latency_band_3_10s");
  });

  it("flag OFF: the payload is byte-for-byte the pre-bet shape — no methodology key", async () => {
    flagOff();
    const res = weeklyResponse(read, {}, 8);
    const body = (await res.json()) as { methodology?: unknown };
    expect("methodology" in body).toBe(false);
  });
});

describe("REEA-1009 S2: /api/echo error classification (403-rotation-fail vs window-abort)", () => {
  it("classifies the two REEA-995 throw shapes and leaves unknowns visible", () => {
    // (i) fetchThroughChallenge exhaustion throw — the last answered status.
    expect(classifyEchoError("HTTP 403")).toBe("rotation_fail");
    // (ii) the joined window aborting mid-rotation (TimeoutError message).
    expect(classifyEchoError("The operation was aborted due to timeout")).toBe("window_abort");
    // A successful probe carries no kind.
    expect(classifyEchoError(undefined)).toBe(null);
    // An unknown failure is surfaced as "other", never squashed into a class.
    expect(classifyEchoError("Unexpected token < in JSON")).toBe("other");
  });
});
