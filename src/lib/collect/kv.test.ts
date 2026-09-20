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

type Call = { url: string; attempt: number; method?: string; body?: string };
let responses: ("value" | "missing" | "error-envelope" | "down")[] = [];
const calls: Call[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init?: { method?: string; body?: string }): Promise<Response> => {
    const url = String(input);
    calls.push({ url, attempt: calls.length, method: init?.method, body: init?.body });
    // REEA-1035 — the keys / pipeline / incrby wires are asserted directly by
    // the describe below; route them on the URL before the sequence logic
    // the getChecked tests drive.
    if (url.includes("/keys/")) {
      if (wire1035.keysMode === "down") throw new Error("KV unreachable");
      if (wire1035.keysMode === "error") return new Response(JSON.stringify({ error: "ERR", ok: false }));
      return new Response(JSON.stringify({ result: wire1035.keysResult, ok: true }));
    }
    if (url.endsWith("/pipeline")) {
      if (wire1035.pipelineMode === "down") throw new Error("KV unreachable");
      const commands = JSON.parse(init?.body ?? "[]") as unknown[][];
      return new Response(JSON.stringify(wire1035.pipelineAnswers(commands)), {
        status: wire1035.pipelineMode === "bad-http" ? 500 : 200,
      });
    }
    if (url.includes("/incrby/")) {
      if (wire1035.incrByMode === "down") throw new Error("KV unreachable");
      return new Response(JSON.stringify({ result: wire1035.incrByResult, ok: true }));
    }
    if (url.includes("/expire/")) {
      wire1035.expireCalls.push(url);
      return new Response(JSON.stringify({ result: 1, ok: true }));
    }
    const mode = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (mode === "down") throw new Error("KV unreachable");
    if (mode === "error-envelope") {
      return new Response(JSON.stringify({ error: "WRONGTYPE", ok: false }));
    }
    if (mode === "missing") return new Response(JSON.stringify({ result: null, ok: true }));
    return new Response(JSON.stringify({ result: '{"version":1,"weeks":{}}', ok: true }));
  }),
);

/**
 * REEA-1035 — mutable wire controls for the keys / pipeline / incrby tests.
 * Kept separate from the getChecked sequence so the original pins stay
 * untouched.
 */
const wire1035 = {
  keysMode: "ok" as "ok" | "down" | "error",
  keysResult: [] as unknown,
  pipelineMode: "ok" as "ok" | "down" | "bad-http",
  /** Build one envelope per command from the parsed pipeline body. */
  pipelineAnswers: (commands: unknown[][]): unknown[] =>
    commands.map((cmd) => {
      const name = String(Array.isArray(cmd) ? cmd[0] : cmd);
      if (name === "MGET") {
        const asked = (Array.isArray(cmd) ? cmd.slice(1) : []) as string[];
        return { result: asked.map((k) => wire1035.store.get(k) ?? null) };
      }
      return { error: `unexpected command ${name}` };
    }),
  incrByMode: "ok" as "ok" | "down",
  incrByResult: 1 as unknown,
  expireCalls: [] as string[],
  store: new Map<string, string>(),
};

const { getSharedKv } = await import("@/lib/collect/kv");

afterEach(() => {
  responses = [];
  calls.length = 0;
  // REEA-1035 wire controls back to defaults
  wire1035.keysMode = "ok";
  wire1035.keysResult = [];
  wire1035.pipelineMode = "ok";
  wire1035.incrByMode = "ok";
  wire1035.incrByResult = 1;
  wire1035.expireCalls.length = 0;
  wire1035.store.clear();
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

describe("REEA-1035 SharedKv keys / mget / incrBy wires", () => {
  it("keys() answers the sorted key list over the REST keys path", async () => {
    wire1035.keysResult = ["metrics:weekly:v2:2026-W38:searches", "metrics:weekly:v2:2026-W37:searches"];
    const out = await getSharedKv()!.keys!("metrics:weekly:v2:*");
    expect(out).toEqual([
      "metrics:weekly:v2:2026-W37:searches",
      "metrics:weekly:v2:2026-W38:searches",
    ]);
    const call = calls.at(-1)!;
    expect(call.url).toContain("/keys/metrics%3Aweekly%3Av2%3A*");
  });

  it("keys() reports down / error-envelope answers as null, never as an empty keyspace", async () => {
    wire1035.keysMode = "down";
    expect(await getSharedKv()!.keys!("x:*")).toBeNull();
    wire1035.keysMode = "error";
    expect(await getSharedKv()!.keys!("x:*")).toBeNull();
  });

  it("mget() issues one pipeline POST with a 2D MGET command and aligns values (missing → null)", async () => {
    wire1035.store.set("k1", "7");
    const before = calls.length;
    const out = await getSharedKv()!.mget!(["k1", "k2"]);
    expect(out).toEqual(["7", null]);
    const call = calls.at(-1)!;
    expect(calls.length).toBe(before + 1); // one round trip for the whole batch
    expect(call.url.endsWith("/pipeline")).toBe(true);
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body!)).toEqual([["MGET", "k1", "k2"]]);
  });

  it("mget() collapses a down / non-OK / error-envelope pipeline to null (no partial keyspace pose)", async () => {
    wire1035.pipelineMode = "down";
    expect(await getSharedKv()!.mget!(["k1"])).toBeNull();
    wire1035.pipelineMode = "bad-http";
    expect(await getSharedKv()!.mget!(["k1"])).toBeNull();
    wire1035.pipelineMode = "ok";
    wire1035.pipelineAnswers = () => [{ error: "ERR wrong type" }];
    expect(await getSharedKv()!.mget!(["k1"])).toBeNull();
  });

  it("mget() on an empty key list answers [] without touching the store", async () => {
    const before = calls.length;
    expect(await getSharedKv()!.mget!([])).toEqual([]);
    expect(calls.length).toBe(before);
  });

  it("incrBy() rides the incrby path and arms the expire only when the key was created", async () => {
    wire1035.incrByResult = 9; // key existed (9 ≠ the requested 4) → no expire
    const out = await getSharedKv()!.incrBy!("metrics:weekly:v2:2026-W38:searches", 4, 60);
    expect(out).toBe(9);
    expect(calls.at(-1)!.url).toContain("/incrby/metrics%3Aweekly%3Av2%3A2026-W38%3Asearches/4");
    expect(wire1035.expireCalls).toHaveLength(0);

    wire1035.incrByResult = 4; // answer == requested increment → key created here
    const created = await getSharedKv()!.incrBy!("metrics:weekly:v2:2026-W38:offer:Xcite", 4, 60);
    expect(created).toBe(4);
    expect(wire1035.expireCalls).toHaveLength(1);
    expect(wire1035.expireCalls[0]).toContain(
      `/expire/metrics%3Aweekly%3Av2%3A2026-W38%3Aoffer%3AXcite/60`,
    );
  });

  it("incrBy() reports a down store as null — the caller degrades, the request never fails", async () => {
    wire1035.incrByMode = "down";
    expect(await getSharedKv()!.incrBy!("k", 1, 60)).toBeNull();
  });
});
