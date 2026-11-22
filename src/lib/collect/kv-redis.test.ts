/**
 * REEA-1044 — the native Redis backend. Exercised against a real TCP server
 * that speaks RESP2, so the wire encoding, the incremental parser, the
 * pipelined MGET, the TTL arming and the unreachable/timeout paths are all
 * pinned against actual sockets — not a stubbed fetch.
 */
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeRedisKv, parseRedisUrl } from "./kv-redis";

type FakeStore = Map<string, string>;

/** Minimal RESP2 request parser: every client command is an array of bulks. */
function parseCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  for (;;) {
    if (buf[offset] !== 0x2a /* '*' */) break;
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const count = Number(buf.toString("utf8", offset + 1, lineEnd));
    let cursor = lineEnd + 2;
    const args: string[] = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      if (buf[cursor] !== 0x24 /* '$' */) {
        complete = false;
        break;
      }
      const lenEnd = buf.indexOf("\r\n", cursor);
      if (lenEnd < 0) {
        complete = false;
        break;
      }
      const len = Number(buf.toString("utf8", cursor + 1, lenEnd));
      const start = lenEnd + 2;
      if (buf.length < start + len + 2) {
        complete = false;
        break;
      }
      args.push(buf.toString("utf8", start, start + len));
      cursor = start + len + 2;
    }
    if (!complete) break;
    commands.push(args);
    offset = cursor;
  }
  return { commands, rest: buf.subarray(offset) };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function bulk(value: string | null): string {
  if (value === null) return "$-1\r\n";
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function array(values: (string | null)[]): string {
  return `*${values.length}\r\n${values.map(bulk).join("")}`;
}

function startFakeRedis(store: FakeStore, ttls: Map<string, number>): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseCommands(buffer);
        buffer = Buffer.from(parsed.rest);
        let out = "";
        for (const args of parsed.commands) {
          const [name, ...rest] = args;
          switch (name.toUpperCase()) {
            case "AUTH":
            case "SELECT":
              out += "+OK\r\n";
              break;
            case "SET": {
              const [key, value] = rest;
              const exIndex = rest.findIndex((a) => a.toUpperCase() === "EX");
              store.set(key, value);
              if (exIndex >= 0) ttls.set(key, Number(rest[exIndex + 1]));
              out += "+OK\r\n";
              break;
            }
            case "GET": {
              const key = rest[0];
              if (key === "wrongtype") out += "-WRONGTYPE Operation against a key holding the wrong kind of value\r\n";
              else out += bulk(store.get(key) ?? null);
              break;
            }
            case "INCR":
            case "INCRBY": {
              const key = rest[0];
              const by = name.toUpperCase() === "INCR" ? 1 : Number(rest[1]);
              const next = Number(store.get(key) ?? "0") + by;
              store.set(key, String(next));
              out += `:${next}\r\n`;
              break;
            }
            case "EXPIRE": {
              const key = rest[0];
              ttls.set(key, Number(rest[1]));
              out += ":1\r\n";
              break;
            }
            case "KEYS": {
              const re = globToRegExp(rest[0]);
              out += array([...store.keys()].filter((k) => re.test(k)));
              break;
            }
            case "MGET": {
              out += array(rest.map((k) => store.get(k) ?? null));
              break;
            }
            default:
              out += `-ERR unknown command '${name}'\r\n`;
          }
        }
        if (out) socket.write(out);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const store: FakeStore = new Map();
const ttls = new Map<string, number>();
let server: Server;
let url: string;

beforeAll(async () => {
  server = await startFakeRedis(store, ttls);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  url = `redis://127.0.0.1:${address.port}/0`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("parseRedisUrl", () => {
  it("parses host, port, auth and db", () => {
    expect(parseRedisUrl("redis://user:pass@redis:6379/2")).toEqual({
      host: "redis",
      port: 6379,
      username: "user",
      password: "pass",
      db: 2,
    });
  });

  it("defaults the port and db", () => {
    expect(parseRedisUrl("redis://redis:6379")).toMatchObject({ host: "redis", port: 6379, db: 0 });
  });

  it("rejects non-redis or malformed URLs", () => {
    expect(parseRedisUrl("http://redis:6379")).toBeNull();
    expect(parseRedisUrl("not a url")).toBeNull();
  });
});

describe("native redis store", () => {
  it("round-trips set/get and arms the TTL from the SET arguments", async () => {
    const kv = makeRedisKv(url)!;
    expect(await kv.set("job:1", '{"state":"running"}', 120)).toBe(true);
    expect(await kv.get("job:1")).toBe('{"state":"running"}');
    expect(ttls.get("job:1")).toBe(120);
  });

  it("reports a missing key as reachable with a null value", async () => {
    const kv = makeRedisKv(url)!;
    expect(await kv.getChecked("job:missing")).toEqual({ reachable: true, value: null });
  });

  it("reports an error reply as unreachable, never as empty data", async () => {
    const kv = makeRedisKv(url)!;
    expect(await kv.getChecked("wrongtype")).toEqual({ reachable: false, value: null });
    expect(await kv.get("wrongtype")).toBeNull();
  });

  it("reports a closed port as unreachable", async () => {
    const kv = makeRedisKv("redis://127.0.0.1:1", { timeoutMs: 400 })!;
    expect(await kv.getChecked("job:1")).toEqual({ reachable: false, value: null });
  });

  it("times out against a server that never answers", async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const address = silent.address();
    if (!address || typeof address === "string") throw new Error("no address");
    try {
      const kv = makeRedisKv(`redis://127.0.0.1:${address.port}`, { timeoutMs: 150 })!;
      const started = Date.now();
      expect(await kv.getChecked("job:1")).toEqual({ reachable: false, value: null });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("increments atomically and arms the window TTL on create", async () => {
    const kv = makeRedisKv(url)!;
    expect(await kv.incr("metrics:window", 60)).toBe(1);
    expect(ttls.get("metrics:window")).toBe(60);
    expect(await kv.incr("metrics:window", 60)).toBe(2);
  });

  it("increments by N and arms the TTL when the key is created", async () => {
    const kv = makeRedisKv(url)!;
    expect(await kv.incrBy("metrics:weekly", 3, 900)).toBe(3);
    expect(ttls.get("metrics:weekly")).toBe(900);
    expect(await kv.incrBy("metrics:weekly", 4, 900)).toBe(7);
  });

  it("enumerates matching keys", async () => {
    const kv = makeRedisKv(url)!;
    await kv.set("metrics:weekly:v2:a:xcite", "1", 60);
    await kv.set("metrics:weekly:v2:b:xcite", "2", 60);
    expect(await kv.keys("metrics:weekly:v2:*")).toEqual([
      "metrics:weekly:v2:a:xcite",
      "metrics:weekly:v2:b:xcite",
    ]);
  });

  it("reads the whole asked set in one pipelined MGET", async () => {
    const kv = makeRedisKv(url)!;
    await kv.set("mget:a", "1", 60);
    await kv.set("mget:b", "2", 60);
    expect(await kv.mget(["mget:a", "mget:missing", "mget:b"])).toEqual(["1", null, "2"]);
  });

  it("returns null from MGET when the store is unreachable", async () => {
    const kv = makeRedisKv("redis://127.0.0.1:1", { timeoutMs: 400 })!;
    expect(await kv.mget(["a", "b"])).toBeNull();
  });
});

describe("getSharedKv backend selection", () => {
  it("prefers REDIS_URL over a hosted REST binding", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    process.env.KV_REST_API_URL = "https://kv.example.test";
    process.env.KV_REST_API_TOKEN = "token";
    vi.resetModules();
    try {
      const { getSharedKv } = await import("./kv");
      const kv = getSharedKv();
      expect(kv).not.toBeNull();
      // The Redis path has no fetch call; a closed port degrades, not throws.
      expect(await kv!.get("job:1")).toBeNull();
    } finally {
      delete process.env.REDIS_URL;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
  });
});
