/**
 * REEA-1250 — runtime memory readings are the input to the recycle policy and
 * the deploy gate, so the parsers and the heap-cap assertion are pinned here.
 *
 * The cgroup layout differs between v2 (`anon`) and v1 (`total_rss`), and the
 * deploy gate's whole point is that an app started without an explicit V8 heap
 * cap is detectable from inside the process. Neither can be measured against
 * the live box in a unit test, so the pure pieces are tested directly.
 */
import { describe, expect, it } from "vitest";
import {
  NODE_HEAP_CAP_BYTES,
  NODE_HEAP_CAP_TOLERANCE_BYTES,
  heapCapOk,
  parseCgroupAnonBytes,
  percentOf,
  readRuntimeMemory,
} from "@/lib/runtime-memory";

describe("REEA-1250 cgroup anonymous-memory parsing", () => {
  it("reads the cgroup v2 anon line", () => {
    const stat = "anon 4509715661\nfile 19439616\nkernel 8962048\n";
    expect(parseCgroupAnonBytes(stat)).toBe(4_509_715_661);
  });

  it("reads the cgroup v1 total_rss line", () => {
    const stat = "cache 1234\ntotal_rss 987654\nrss 987654\n";
    expect(parseCgroupAnonBytes(stat)).toBe(987_654);
  });

  it("returns null when the stat carries no anonymous figure", () => {
    expect(parseCgroupAnonBytes("file 123\nkernel 45\n")).toBeNull();
    expect(parseCgroupAnonBytes("")).toBeNull();
  });
});

describe("REEA-1250 heap cap assertion", () => {
  it("accepts the image's 2 GiB cap (V8 rounds it up a little)", () => {
    expect(heapCapOk(NODE_HEAP_CAP_BYTES)).toBe(true);
    expect(heapCapOk(NODE_HEAP_CAP_BYTES + NODE_HEAP_CAP_TOLERANCE_BYTES)).toBe(true);
  });

  it("rejects the uncapped default V8 sizes from host memory", () => {
    // Measured on the 32 GB production box before this ticket: 4,144 MiB.
    expect(heapCapOk(4144 * 1024 * 1024)).toBe(false);
    expect(heapCapOk(0)).toBe(false);
  });
});

describe("REEA-1250 percent helper", () => {
  it("computes a bounded percentage and degrades to null without a limit", () => {
    expect(percentOf(3_000_000_000, 6_000_000_000)).toBe(50);
    expect(percentOf(4_509_715_661, 6_442_450_944)).toBe(70);
    expect(percentOf(null, 6_442_450_944)).toBeNull();
    expect(percentOf(10, null)).toBeNull();
    expect(percentOf(10, 0)).toBeNull();
  });
});

describe("REEA-1250 runtime snapshot", () => {
  it("always reports the Node process's own figures", () => {
    const snapshot = readRuntimeMemory();
    expect(snapshot.rssBytes).toBeGreaterThan(0);
    expect(snapshot.heapLimitBytes).toBeGreaterThan(0);
    expect(snapshot.heapCapBytes).toBe(NODE_HEAP_CAP_BYTES);
    expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // A host without cgroup files (local dev, CI) degrades to nulls instead of
    // throwing; the fields exist either way.
    expect(snapshot.cgroup).toHaveProperty("limitBytes");
    expect(snapshot.cgroup).toHaveProperty("anonBytes");
  });
});
