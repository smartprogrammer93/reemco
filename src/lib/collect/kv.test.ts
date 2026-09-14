/**
 * REEA-996 — the checked KV read. `get()` collapses "store unreachable" and
 * "key missing" into one null, which is exactly how a failed shared read
 * masqueraded as an honest empty store for the weekly metrics endpoint.
 * getChecked keeps the facts apart and absorbs one transient blip with a
 * short backoff. The Upstash REST endpoint is emulated by a fetch stub —
 * no real network is touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.KV_REST_API_URL = "https://kv-checked.example.test/";
process.env.KV_REST_API_TOKEN = "test-token";

type Call = { url: string; attempt: number };
let responses: ("value" | "missing" | "error-envelope" | "down")[] = [];
const calls: Call[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL): Promise<Response> => {
    calls.push({ url: String(input), attempt: calls.length });
    const mode = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (mode === "down") throw new Error("KV unreachable");
    if (mode === "error-envelope") {
      return new Response(JSON.stringify({ error: "WRONGTYPE", ok: false }));
    }
    if (mode === "missing") return new Response(JSON.stringify({ result: null, ok: true }));
    return new Response(JSON.stringify({ result: '{"version":1,"weeks":{}}', ok: true }));
  }),
);

const { getSharedKv } = await import("@/lib/collect/kv");

afterEach(() => {
  responses = [];
  calls.length = 0;
});

describe("REEA-996 SharedKv.getChecked", () => {
  it("reports a reachable present value", async () => {
    responses = ["value"];
    const out = await getSharedKv()!.getChecked!("metrics:weekly:v1");
    expect(out).toEqual({ reachable: true, value: '{"version":1,"weeks":{}}' });
    expect(calls).toHaveLength(1); // no retry on a clean read
  });

  it("reports a reachable missing key as reachable-with-null, not unreachable", async () => {
    responses = ["missing"];
    const out = await getSharedKv()!.getChecked!("metrics:weekly:v1");
    expect(out).toEqual({ reachable: true, value: null });
    expect(calls).toHaveLength(1);
  });

  it("reports an Upstash error envelope as unreachable, not as an empty store", async () => {
    responses = ["error-envelope"];
    const out = await getSharedKv()!.getChecked!("metrics:weekly:v1");
    expect(out).toEqual({ reachable: false, value: null });
  });

  it("retries exactly once after a transient failure and recovers", async () => {
    responses = ["down", "value"];
    const out = await getSharedKv()!.getChecked!("metrics:weekly:v1");
    expect(out.reachable).toBe(true);
    expect(out.value).toBe('{"version":1,"weeks":{}}');
    expect(calls).toHaveLength(2); // one backoff retry, no more
  });

  it("gives up after the single retry when the store stays down", async () => {
    responses = ["down"];
    const out = await getSharedKv()!.getChecked!("metrics:weekly:v1");
    expect(out).toEqual({ reachable: false, value: null });
    expect(calls).toHaveLength(2);
  });
});
