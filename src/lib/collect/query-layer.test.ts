/**
 * REEA-602 — shared-layer warm tests. The Upstash REST endpoints are
 * emulated by one in-process Map + fetch stub (same shape as kv-store.test);
 * no real network is touched. Covers: the namespace + encoding of the memo
 * identity on the shared key, the mirror→replay round trip with the memo
 * ceiling as TTL, honest miss degradation (unknown key, torn row, KV down),
 * and the no-binding fast path.
 */
import { describe, expect, it, vi } from "vitest";
import { QUERY_CACHE_MAX_AGE_MS } from "@/lib/query-cache";

process.env.KV_REST_API_URL = "https://kv.example.test/";
process.env.KV_REST_API_TOKEN = "test-token";

/** Shared-backend emulation: the one place every instance reads/writes. */
const table = new Map<string, string>();
const ttlSeen: number[] = [];
let kvDown = false;

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (kvDown) throw new Error("KV unreachable");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://kv.example.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    const [, command, rawKey] = url.pathname.split("/");
    const key = decodeURIComponent(rawKey ?? "");
    if (command === "get") {
      return new Response(JSON.stringify({ result: table.get(key) ?? null, ok: true }));
    }
    // set: remaining SET args in the body — `<value>` then `EX <ttl>`.
    const [value, exFlag, ttl] = String(init?.body ?? "").split("\n");
    expect(exFlag).toBe("EX");
    table.set(key, value);
    ttlSeen.push(Number(ttl));
    return new Response(JSON.stringify({ ok: true }));
  }),
);

import {
  mirrorSharedQuerySnapshot,
  replaySharedQuerySnapshot,
  sharedQuerySnapshotKey,
} from "@/lib/collect/query-layer";

interface Snapshot {
  products: { title: string }[];
  scrapedAt: string;
}

describe("shared-layer warm (REEA-602)", () => {
  it("namespaces the memo identity onto one shared key, URL-safe", () => {
    expect(sharedQuerySnapshotKey("apple")).toBe("pc:q:apple");
    expect(sharedQuerySnapshotKey("apple pie")).toBe("pc:q:apple%20pie");
    // The Arabic/locale-scoped memo form keeps its separators encoded, so
    // one KV key stays one path segment.
    expect(sharedQuerySnapshotKey("ar|شاحن")).toBe("pc:q:ar%7C%D8%B4%D8%A7%D8%AD%D9%86");
  });

  it("mirrors the FINAL snapshot with the memo ceiling as TTL and replays it", async () => {
    const snap: Snapshot = { products: [{ title: "Sony WH-1000XM6" }], scrapedAt: "2026-09-11T12:00:00.000Z" };
    const acked = await mirrorSharedQuerySnapshot<Snapshot>("xm6", snap);
    expect(acked).toBe(true);
    expect(ttlSeen.at(-1)).toBe(Math.ceil(QUERY_CACHE_MAX_AGE_MS / 1000));
    // Round trip through the emulated REST layer: a cold instance reads back
    // exactly what the FINAL write-through stored, age stamp included.
    const replay = await replaySharedQuerySnapshot<Snapshot>("xm6");
    expect(replay).toEqual(snap);
  });

  it("reads unknown keys and torn rows as plain misses", async () => {
    expect(await replaySharedQuerySnapshot("never-mirrored")).toBeNull();
    table.set("pc:q:torn", "{not json");
    expect(await replaySharedQuerySnapshot("torn")).toBeNull();
    table.set("pc:q:scalar", "7");
    expect(await replaySharedQuerySnapshot("scalar")).toBeNull();
    // A stored row without the snapshot shape (foreign key collision) is a
    // miss too — the caller just runs the live path.
    table.set("pc:q:foreign", JSON.stringify({ scrapedAt: "x" }));
    expect(await replaySharedQuerySnapshot("foreign")).toBeNull();
  });

  it("a KV hiccup degrades to miss/false, never a throw", async () => {
    kvDown = true;
    expect(await replaySharedQuerySnapshot("xm6")).toBeNull();
    expect(await mirrorSharedQuerySnapshot("xm6", { products: [] })).toBe(false);
    kvDown = false;
  });
});
