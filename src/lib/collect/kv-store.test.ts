/**
 * REEA-92 — shared collect-job KV store.
 *
 * Covers the shared-storage contract: a job created by one request must be
 * readable from ANY instance afterwards (simulated by clearing the process
 * memory layer between create and read), writes carry a TTL, and every KV
 * hiccup degrades to the local layers instead of failing the request. The
 * Upstash REST endpoints are emulated by one in-process Map + fetch stub —
 * no real network is touched.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@/lib/collect/types";

const cacheDir = mkdtempSync(join(tmpdir(), "reemco-kv-test-"));
process.env.COLLECT_CACHE_DIR = cacheDir;
process.env.KV_REST_API_URL = "https://kv.example.test/";
process.env.KV_REST_API_TOKEN = "test-token";

/** Shared-backend emulation: the one place every instance reads/writes. */
const table = new Map<string, { value: string; ttl: number }>();
let kvDown = false;

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (kvDown) throw new Error("KV unreachable");
    const url = new URL(String(input));
    const [, command, rawKey] = url.pathname.split("/");
    const key = decodeURIComponent(rawKey ?? "");
    expect(url.origin).toBe("https://kv.example.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    if (command === "get") {
      const entry = table.get(key);
      return new Response(JSON.stringify({ result: entry?.value ?? null, ok: true }));
    }
    // set: remaining SET args in the body — `<value>` then `EX <ttl>`.
    const [value, exFlag, ttl] = String(init?.body ?? "").split("\n");
    expect(exFlag).toBe("EX");
    table.set(key, { value, ttl: Number(ttl) });
    return new Response(JSON.stringify({ result: "OK", ok: true }));
  }),
);

const {
  resetStoreForTests,
  createJob,
  touchJob,
  getJob,
  getInflightJobId,
  finishJob,
  findFreshCompleted,
} = await import("@/lib/collect/store");

beforeEach(() => {
  // Memory layer only — the shared table persists across "instances".
  resetStoreForTests();
});

describe("shared KV store (REEA-92)", () => {
  it("publishes job snapshots to the shared store with a bounded TTL", async () => {
    const job = await createJob("kv-product");
    job.subtasks = [{ retailer: "Xcite", domain: "xcite.com", status: "collecting", offersFound: 0 }];
    await touchJob(job);
    const entry = table.get(`collect:job:${job.jobId}`);
    expect(entry).toBeTruthy();
    expect((JSON.parse(entry!.value) as CollectJob).subtasks[0].status).toBe("collecting");
    expect(entry!.ttl).toBe(3600); // jobs answerable for 1 h, then expire
  });

  it("a follow-up request on a fresh instance reads the same job state", async () => {
    const job = await createJob("kv-product");
    await touchJob(job);
    resetStoreForTests(); // simulate the poll landing on another instance
    const seen = await getJob(job.jobId);
    expect(seen?.jobId).toBe(job.jobId);
    expect(seen?.productId).toBe("kv-product");
    // ...and the in-flight pointer dedupes repeat starts across instances too.
    expect(await getInflightJobId("kv-product")).toBe(job.jobId);
  });

  it("completed jobs are shared: any instance answers the stale-cache lookup", async () => {
    const job = await createJob("kv-product");
    job.status = "complete";
    await finishJob(job);
    resetStoreForTests(); // another instance
    const fresh = await findFreshCompleted("kv-product");
    expect(fresh?.jobId).toBe(job.jobId);
  });

  it("falls through to the disk completed-cache when the KV entry is absent", async () => {
    // Degraded-mode parity: without a KV entry the pre-REEA-92 disk layer
    // still answers, so no results page blanks when KV lags.
    const finishedAt = new Date().toISOString();
    const diskJob: CollectJob = {
      jobId: "disk-job",
      productId: "disk-product",
      status: "complete",
      mode: "cache",
      startedAt: finishedAt,
      finishedAt,
      subtasks: [],
      offers: [],
    };
    writeFileSync(
      join(cacheDir, "completed-jobs.json"),
      JSON.stringify({ "disk-product": diskJob }),
    );
    const fresh = await findFreshCompleted("disk-product");
    expect(fresh?.jobId).toBe("disk-job");
  });

  it("KV outage degrades to memory instead of failing the poll", async () => {
    const job = await createJob("kv-product");
    await touchJob(job);
    kvDown = true;
    const seen = await getJob(job.jobId);
    expect(seen?.jobId).toBe(job.jobId);
    kvDown = false;
  });
});
