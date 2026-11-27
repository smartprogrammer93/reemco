/**
 * REEA-1250 — the app's real memory ceiling, read from the cgroup it runs
 * under instead of from the host's `/proc/meminfo`.
 *
 * Why: `/proc/meminfo` inside a container reports the HOST's memory, not the
 * container's, so an app capped at 6 GiB could read 26 GB "available" and never
 * see the OOM coming. The browser-clearance tier and `/api/echo` need the same
 * numbers (the cgroup limit, current usage, and anonymous memory), and the
 * recycle policy must be driven by the memory the kernel will actually kill
 * over.
 *
 * Read-only and best-effort: a host without cgroup files (local dev, a CI
 * runner, a non-Linux host) returns nulls, and callers degrade to the Node
 * process's own RSS. Never throws.
 *
 * Anonymous memory (`anon` on cgroup v2, `total_rss` on v1) is the OOM
 * signal. `memory.current` also carries page cache written by the durable
 * volumes (`/data/events`, `/data/metrics`), which is reclaimable under
 * pressure; gating on it alone would page a healthy box. Both are reported so
 * the deploy gate can assert on the anonymous figure and record the other.
 */

import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

/** REEA-1250 — the heap cap the app image is started with (`--max-old-space-size`). */
export const NODE_HEAP_CAP_BYTES = 2048 * 1024 * 1024;
/**
 * V8 rounds `--max-old-space-size` up (young generation + alignment), so the
 * reported limit is a little above the requested cap. This tolerance is what
 * makes "the cap is present" assertable without pinning an exact build.
 */
export const NODE_HEAP_CAP_TOLERANCE_BYTES = 256 * 1024 * 1024;

export interface CgroupMemorySnapshot {
  /** null when the cgroup publishes no limit ("max" on v2). */
  limitBytes: number | null;
  /** `memory.current` (v2) / `memory.usage_in_bytes` (v1), page cache included. */
  usedBytes: number | null;
  /** `anon` (v2) / `total_rss` (v1) — the memory an OOM kill is charged for. */
  anonBytes: number | null;
  /** limit - used, clamped at 0. null when either figure is unknown. */
  availableBytes: number | null;
}

export interface RuntimeMemorySnapshot {
  cgroup: CgroupMemorySnapshot;
  /** The Node process's own RSS (does NOT include Chromium child processes). */
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  heapCapBytes: number;
  /** True when the running V8 heap limit is inside the declared cap. */
  heapCapOk: boolean;
  /** used / limit, 0-100, or null when there is no limit. */
  usedPercent: number | null;
  /** anon / limit, 0-100, or null when there is no limit. */
  anonPercent: number | null;
  /**
   * The HOST's MemAvailable, kept for continuity with the pre-REEA-1250 echo
   * payload. It is NOT the container's headroom — use `cgroup` for that.
   */
  hostAvailableBytes: number | null;
  uptimeSeconds: number;
}

type CgroupPaths = {
  limit: string;
  current: string;
  stat: string;
};

const CGROUP_V2: CgroupPaths = {
  limit: "/sys/fs/cgroup/memory.max",
  current: "/sys/fs/cgroup/memory.current",
  stat: "/sys/fs/cgroup/memory.stat",
};

const CGROUP_V1: CgroupPaths = {
  limit: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  current: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  stat: "/sys/fs/cgroup/memory/memory.stat",
};

function readNumber(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "" || raw === "max") return null;
    const n = Number(raw);
    // cgroup v1 publishes "unlimited" as a near-2^63 sentinel; treat anything
    // past 1 PiB as "no practical limit".
    return Number.isFinite(n) && n > 0 && n < 1e15 ? n : null;
  } catch {
    return null;
  }
}

/** Parse the anonymous-memory line out of a cgroup v2/v1 `memory.stat`. */
export function parseCgroupAnonBytes(stat: string): number | null {
  const match = /^(?:anon|total_rss)\s+(\d+)\s*$/m.exec(stat);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function readCgroupAt(paths: CgroupPaths): CgroupMemorySnapshot {
  const usedBytes = readNumber(paths.current);
  const limitBytes = readNumber(paths.limit);
  let anonBytes: number | null = null;
  try {
    anonBytes = parseCgroupAnonBytes(readFileSync(paths.stat, "utf8"));
  } catch {
    anonBytes = null;
  }
  // A container can run under v1 while v2 paths exist on the host; if neither
  // v2 file answered, fall back to the v1 layout.
  if (usedBytes == null && limitBytes == null && anonBytes == null && paths !== CGROUP_V1) {
    return readCgroupAt(CGROUP_V1);
  }
  const availableBytes =
    limitBytes != null && usedBytes != null ? Math.max(0, limitBytes - usedBytes) : null;
  return { limitBytes, usedBytes, anonBytes, availableBytes };
}

/** Read the cgroup the process is in, v2 first then v1. Never throws. */
export function readCgroupMemory(): CgroupMemorySnapshot {
  return readCgroupAt(CGROUP_V2);
}

export function percentOf(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole <= 0) return null;
  return Math.round((part / whole) * 10_000) / 100;
}

/** True when the running heap limit carries the explicit cap the image sets. */
export function heapCapOk(heapLimitBytes: number): boolean {
  return heapLimitBytes > 0 && heapLimitBytes <= NODE_HEAP_CAP_BYTES + NODE_HEAP_CAP_TOLERANCE_BYTES;
}

/**
 * The runtime memory picture: cgroup pressure, Node RSS/heap, and whether the
 * start command carries the explicit heap cap. Used by the recycle policy, the
 * `/api/echo` diagnostic and the deploy-gate assertion.
 */
export function readRuntimeMemory(): RuntimeMemorySnapshot {
  let heapUsedBytes = 0;
  let heapLimitBytes = 0;
  let rssBytes = 0;
  try {
    const usage = process.memoryUsage();
    rssBytes = usage.rss;
    heapUsedBytes = usage.heapUsed;
  } catch {
    // best-effort
  }
  try {
    heapLimitBytes = getHeapStatistics().heap_size_limit;
  } catch {
    heapLimitBytes = 0;
  }
  const cgroup = readCgroupMemory();
  let hostAvailableBytes: number | null = null;
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = /MemAvailable:\s+(\d+)/.exec(info)?.[1];
    hostAvailableBytes = kb ? Number(kb) * 1024 : null;
  } catch {
    hostAvailableBytes = null;
  }
  return {
    cgroup,
    rssBytes,
    heapUsedBytes,
    heapLimitBytes,
    heapCapBytes: NODE_HEAP_CAP_BYTES,
    heapCapOk: heapCapOk(heapLimitBytes),
    usedPercent: percentOf(cgroup.usedBytes, cgroup.limitBytes),
    anonPercent: percentOf(cgroup.anonBytes, cgroup.limitBytes),
    hostAvailableBytes,
    uptimeSeconds: Math.round(process.uptime()),
  };
}
