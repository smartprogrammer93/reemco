/**
 * REEA-1044 — native Redis backend for the shared KV contract.
 *
 * The self-hosted stack runs a local Valkey/Redis container on the private
 * compose network. The app used to reach a shared store only through the
 * Vercel KV / Upstash REST contract; on the single-server deployment that
 * meant either a hosted Upstash store or a REST shim in front of local Redis.
 * The shim answered 404 for the path-style commands this app issues
 * (`/get/<key>`, `/incrby/<key>/<n>`, `/keys/<pattern>`), so every KV call
 * degraded and the box silently ran on its per-container /data store.
 *
 * This module speaks RESP directly to `REDIS_URL` — no gateway, no third
 * party, no extra dependency (the app's dependency surface stays as it is,
 * and the standalone Next output needs no extra tracing).
 *
 * Deliberately NOT a long-lived client: every command is one short TCP
 * connection that is destroyed as soon as its reply is parsed. The contract
 * here is best-effort (a KV hiccup degrades the caller, never fails the
 * request), so a per-command socket gives a hard timeout, no background
 * reconnect loop, no offline command queue, and no unhandled client "error"
 * event that could take the process down. On the local compose network the
 * connect cost is sub-millisecond.
 */
import { createConnection } from "node:net";

const KV_TIMEOUT_MS = 2500;

/** REEA-996 parity: one short backoff retry on a checked read. */
const KV_GET_RETRY_BACKOFF_MS = 200;

/** One decoded RESP2 reply. Errors are values, not exceptions. */
type Reply =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "null" }
  | { kind: "array"; value: Reply[] }
  | { kind: "error"; message: string };

interface RedisTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  db: number;
}

/**
 * Parse `redis://[user[:password]@]host[:port][/db]`. Returns null for an
 * unusable URL rather than throwing, so a typo in env degrades the caller
 * instead of failing module evaluation.
 */
export function parseRedisUrl(raw: string): RedisTarget | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "redis:") return null;
    const dbText = url.pathname.replace(/^\/+/, "");
    const db = dbText === "" ? 0 : Number(dbText);
    if (!Number.isInteger(db) || db < 0) return null;
    return {
      host: url.hostname || "127.0.0.1",
      port: url.port ? Number(url.port) : 6379,
      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
      db,
    };
  } catch {
    return null;
  }
}

/** RESP2 command encoding — array of bulk strings. */
function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

/**
 * Incremental RESP2 parser. Returns null when the buffer does not yet hold a
 * complete reply (the caller waits for more bytes and re-parses from the
 * start — replies are small, so this is cheap).
 */
function parseReply(buf: Buffer, offset: number): { reply: Reply; next: number } | null {
  if (offset >= buf.length) return null;
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buf[offset]);
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  switch (type) {
    case "+":
      return { reply: { kind: "string", value: line }, next };
    case "-":
      return { reply: { kind: "error", message: line }, next };
    case ":":
      return { reply: { kind: "number", value: Number(line) }, next };
    case "$": {
      const len = Number(line);
      if (len === -1) return { reply: { kind: "null" }, next };
      if (!Number.isInteger(len) || len < 0) {
        return { reply: { kind: "error", message: `bad bulk length ${line}` }, next };
      }
      if (buf.length < next + len + 2) return null;
      return {
        reply: { kind: "string", value: buf.toString("utf8", next, next + len) },
        next: next + len + 2,
      };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { reply: { kind: "null" }, next };
      if (!Number.isInteger(count) || count < 0) {
        return { reply: { kind: "error", message: `bad array length ${line}` }, next };
      }
      const items: Reply[] = [];
      let cursor = next;
      for (let i = 0; i < count; i++) {
        const parsed = parseReply(buf, cursor);
        if (!parsed) return null;
        items.push(parsed.reply);
        cursor = parsed.next;
      }
      return { reply: { kind: "array", value: items }, next: cursor };
    }
    default:
      return { reply: { kind: "error", message: `unexpected RESP type ${type}` }, next };
  }
}

/**
 * Run a pipelined batch of commands over one short-lived connection.
 * Returns null when the store could not be reached (connect error, timeout,
 * socket error) — the caller treats that as "unreachable", never as data.
 */
function execute(
  target: RedisTarget,
  commands: string[][],
  timeoutMs: number,
): Promise<Reply[] | null> {
  const prefix: string[][] = [];
  if (target.password) {
    prefix.push(
      target.username ? ["AUTH", target.username, target.password] : ["AUTH", target.password],
    );
  }
  if (target.db !== 0) prefix.push(["SELECT", String(target.db)]);
  const wire = Buffer.concat([...prefix, ...commands].map(encodeCommand));
  const expected = prefix.length + commands.length;

  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: target.host, port: target.port });
    let buffer = Buffer.alloc(0);

    const finish = (value: Reply[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.on("error", () => finish(null));
    socket.on("connect", () => socket.write(wire));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const replies: Reply[] = [];
      let offset = 0;
      for (;;) {
        const parsed = parseReply(buffer, offset);
        if (!parsed) break;
        replies.push(parsed.reply);
        offset = parsed.next;
        if (replies.length === expected) {
          finish(replies.slice(prefix.length));
          return;
        }
      }
    });
    // A socket timeout event is belt-and-braces: the timer above owns the
    // deadline, and net's own timeout only fires on inactivity.
    socket.setTimeout(timeoutMs, () => finish(null));
  });
}

export interface KvGetOutcome {
  reachable: boolean;
  value: string | null;
}

export interface RedisKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  incr(key: string, ttlSeconds: number): Promise<number | null>;
  incrBy(key: string, by: number, ttlSeconds: number): Promise<number | null>;
  getChecked(key: string): Promise<KvGetOutcome>;
  keys(pattern: string): Promise<string[] | null>;
  mget(keys: string[]): Promise<(string | null)[] | null>;
  /** REEA-1241 — drop a key (the clearance cache evicts pre-cap entries). */
  del(key: string): Promise<boolean>;
}

function isError(reply: Reply | undefined): reply is { kind: "error"; message: string } | undefined {
  return !reply || reply.kind === "error";
}

export function makeRedisKv(url: string, options: { timeoutMs?: number } = {}): RedisKv | null {
  const target = parseRedisUrl(url);
  if (!target) return null;
  const timeoutMs = options.timeoutMs ?? KV_TIMEOUT_MS;

  const run = (commands: string[][]) => execute(target, commands, timeoutMs);

  const kv: RedisKv = {
    async get(key) {
      const replies = await run([["GET", key]]);
      const reply = replies?.[0];
      return reply && reply.kind === "string" ? reply.value : null;
    },
    // REEA-996 parity: unreachable and missing stay distinguishable, with the
    // same single backoff retry as the REST path.
    async getChecked(key): Promise<KvGetOutcome> {
      const attempt = async (): Promise<KvGetOutcome> => {
        const replies = await run([["GET", key]]);
        if (replies === null) return { reachable: false, value: null };
        const reply = replies[0];
        if (!reply || reply.kind === "error") return { reachable: false, value: null };
        if (reply.kind === "null") return { reachable: true, value: null };
        return { reachable: true, value: reply.kind === "string" ? reply.value : null };
      };
      const first = await attempt();
      if (first.reachable) return first;
      await new Promise((resolve) => setTimeout(resolve, KV_GET_RETRY_BACKOFF_MS));
      return attempt();
    },
    async set(key, value, ttlSeconds) {
      const replies = await run([
        ["SET", key, value, "EX", String(Math.max(1, Math.ceil(ttlSeconds)))],
      ]);
      const reply = replies?.[0];
      return reply !== undefined && reply.kind === "string" && reply.value === "OK";
    },
    // Atomic server-side increment (INCR), TTL armed when the key is created.
    async incr(key, ttlSeconds) {
      const replies = await run([["INCR", key]]);
      const reply = replies?.[0];
      if (!reply || reply.kind !== "number") return null;
      if (reply.value === 1) {
        await run([["EXPIRE", key, String(Math.max(1, Math.ceil(ttlSeconds)))]]);
      }
      return reply.value;
    },
    // Atomic INCRBY with TTL arming on create (REEA-1035 semantics).
    async incrBy(key, by, ttlSeconds) {
      const n = Math.max(1, Math.floor(by));
      const replies = await run([["INCRBY", key, String(n)]]);
      const reply = replies?.[0];
      if (!reply || reply.kind !== "number") return null;
      if (reply.value === n) {
        await run([["EXPIRE", key, String(Math.max(1, Math.ceil(ttlSeconds)))]]);
      }
      return reply.value;
    },
    async keys(pattern) {
      const replies = await run([["KEYS", pattern]]);
      const reply = replies?.[0];
      if (!reply || reply.kind !== "array") return null;
      const names: string[] = [];
      for (const item of reply.value) {
        if (item.kind === "string") names.push(item.value);
      }
      return names.sort();
    },
    // One pipelined MGET for the whole asked set (chunked only to keep a
    // single command bounded). Any failed chunk collapses the answer to null
    // so a partial keyspace is never reported as honest data.
    async mget(keys) {
      if (keys.length === 0) return [];
      const CHUNK = 256;
      const commands: string[][] = [];
      const chunks: { start: number; keys: string[] }[] = [];
      for (let i = 0; i < keys.length; i += CHUNK) {
        const chunkKeys = keys.slice(i, i + CHUNK);
        chunks.push({ start: i, keys: chunkKeys });
        commands.push(["MGET", ...chunkKeys]);
      }
      const replies = await run(commands);
      if (replies === null || replies.length !== commands.length) return null;
      const values: (string | null)[] = new Array(keys.length).fill(null);
      for (let c = 0; c < chunks.length; c++) {
        const reply = replies[c];
        if (isError(reply) || reply.kind !== "array") return null;
        if (reply.value.length !== chunks[c].keys.length) return null;
        reply.value.forEach((row, j) => {
          values[chunks[c].start + j] = row.kind === "string" ? row.value : null;
        });
      }
      return values;
    },
    // REEA-1241 — DEL for the clearance cache's pre-cap eviction. True only
    // when a key was actually removed; an unreachable store is a failed
    // delete, never an exception.
    async del(key) {
      const replies = await run([["DEL", key]]);
      const reply = replies?.[0];
      return reply !== undefined && reply.kind === "number" && reply.value > 0;
    },
  };

  return kv;
}
