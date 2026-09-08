/**
 * REEA-272 — cross-instance persistence for the challenge cookie jar.
 *
 * The deployed path runs one serverless invocation per query and often
 * recycles instances between queries, so the per-process Map alone cannot
 * carry a cleared Cloudflare jar far (the standing "hits:0 HTTP 403" note
 * QA saw). Tier 2 is the shared KV mirror (REEA-143 binding, see kv.ts):
 * any cold instance replays the mirrored clearance on its FIRST hop attempt,
 * and a freshly cleared jar is written back so the next instance inherits it.
 * The KV is best-effort: missing binding or hiccup falls back to the
 * memory-only handshake, never to a failed hop.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fetchThroughChallenge } from "@/lib/collect/search-fallback";

const originalFetch = globalThis.fetch;

/** Upstash-shaped stub: GET answers `getResult`, every SET body is recorded. */
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

describe("cleared-jar persistence across invocations (REEA-272)", () => {
  it("replays the KV-mirrored clearance on the first attempt of a cold hop", async () => {
    const mirrored = JSON.stringify({ header: "__cf_bm=mirrored", expiresAt: Date.now() + 60_000 });
    stubKv(mirrored, []);

    const seen: Array<RequestInit | undefined> = [];
    const hopFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen.push(init);
      return new Response("<html>archive</html>");
    };
    const res = await fetchThroughChallenge(
      hopFetch,
      "https://pckuwait.com/?s=dell&post_type=product",
      {},
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(200);
    // Cold process Map, warm KV mirror: ONE hop request, already carrying
    // the mirrored jar — the recycled-instance case that kept showing 403.
    expect(seen).toHaveLength(1);
    expect((seen[0]!.headers as Headers).get("cookie")).toContain("__cf_bm=mirrored");
  });

  it("mirrors a freshly cleared jar to the shared store after a handshake", async () => {
    const sets: string[] = [];
    stubKv(null, sets);

    let calls = 0;
    const hopFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response("challenge", { status: 403, headers: { "set-cookie": "__cf_bm=hand42; Path=/" } });
      }
      return new Response("<html>archive</html>");
    };
    const res = await fetchThroughChallenge(
      hopFetch,
      "https://www.luluhypermarket.com/en/search?query=rice",
      {},
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    // The cleared jar must reach the shared store (Upstash SET body carries
    // the value line + EX ttl) before the hop returns, so the next — likely
    // recycled — invocation replays it on attempt one instead of 403-ing.
    expect(sets.length).toBeGreaterThanOrEqual(1);
    expect(sets.join("\n")).toContain("__cf_bm=hand42");
    expect(sets.join("\n")).toMatch(/EX\n\d+/);
  });
});
