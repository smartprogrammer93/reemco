/**
 * REEA-602 — the shared-layer warm on the staged page path. Simulated
 * recycle: instance one converges a query and its FINAL write-through
 * mirrors into the shared KV layer (emulated like kv-store.test — one Map +
 * fetch stub); instance two starts with an EMPTY local memo. Its first
 * flush replays round one's snapshot from the shared layer while its own
 * bounded hops answer a differently-shaped list right behind — proving the
 * replay shortens the first paint without replacing the live-at-query-time
 * fetch, and that the converged FINAL of the SECOND run still closes the
 * stream on its own answer.
 */
import "./test-cache-dir";
import { describe, expect, it, vi } from "vitest";
import { createQueryCache } from "@/lib/query-cache";
import { collectLiveResultsStaged, resetDiscoveryCache } from "@/lib/collect/live-search";
import { replaySharedQuerySnapshot } from "@/lib/collect/query-layer";

process.env.KV_REST_API_URL = "https://kv.example.test/";
process.env.KV_REST_API_TOKEN = "test-token";

/** Shared-backend emulation, same shape as kv-store.test. */
const table = new Map<string, string>();
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const [, command, rawKey] = url.pathname.split("/");
    const key = decodeURIComponent(rawKey ?? "");
    if (command === "get") {
      return new Response(JSON.stringify({ result: table.get(key) ?? null, ok: true }));
    }
    const [value] = String(init?.body ?? "").split("\n");
    table.set(key, value);
    return new Response(JSON.stringify({ ok: true }));
  }),
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** Round one: Xcite answers instantly; everyone else answers empty. */
function warmRoundFetch() {
  return async (url: string): Promise<Response> => {
    if (url.includes("xcite.com")) {
      return jsonResponse({
        results: [{ hits: [{ name: "Samsung Galaxy S26 warm", slug: "s26-w", price: 399, currency: "KWD", inStock: true }] }],
      });
    }
    return jsonResponse({});
  };
}

/** Round two: the recycled instance's OWN hops answer a differently-shaped
 *  list 30 ms in, so the replayed first flush is told apart from them by
 *  content, deterministically. */
function coldRoundFetch() {
  return async (url: string): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (url.includes("xcite.com")) {
      return jsonResponse({
        results: [{ hits: [{ name: "Samsung Galaxy S26 cold", slug: "s26-c", price: 389, currency: "KWD", inStock: true }] }],
      });
    }
    return jsonResponse({});
  };
}

async function awaitMirror(key: string) {
  for (let i = 0; i < 100; i++) {
    const snap = await replaySharedQuerySnapshot(key);
    if (snap) return snap;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("shared-layer mirror did not land");
}

describe("shared-layer warm on the staged path (REEA-602)", () => {
  it("mirrors the FINAL write-through and replays it as a cold instance's first flush", async () => {
    resetDiscoveryCache();

    // Instance one: a normal bounded round; its FINAL answer mirrors into
    // the shared layer behind the response.
    const first = collectLiveResultsStaged("samsung", {
      fetchImpl: warmRoundFetch(),
      cache: createQueryCache(),
      snapshots: true,
      country: "KW",
      deadlineMs: 500,
    });
    const firstSnap = await first.final;
    expect(firstSnap.products.length).toBeGreaterThanOrEqual(1);
    expect(await awaitMirror("samsung")).toBeTruthy();

    // Instance two (recycled): empty local memo, differently-shaped hops.
    const second = collectLiveResultsStaged("samsung", {
      fetchImpl: coldRoundFetch(),
      cache: createQueryCache(),
      snapshots: true,
      country: "KW",
      deadlineMs: 2000,
    });

    // The replay leads the FIRST flush with round one's snapshot…
    const lead = await second.stages[0];
    expect(JSON.stringify(lead).includes("S26 warm")).toBe(true);

    // …while the run's own converged answer still closes the stream: same
    // single fan-out, live offers, honest stamps behind the replay.
    const own = await second.final;
    expect(JSON.stringify(own).includes("S26 cold")).toBe(true);
    expect(JSON.stringify(own).includes("S26 warm")).toBe(false);
  });
});
