/**
 * REEA-84 W1 — collection job store (T1), REEA-92 shared-KV pass.
 *
 * Jobs live for the lifetime of a collection run (<=25 s) plus a short-TTL
 * cache of the last completed job per product (AC5, 10 min). On Vercel each
 * API route can run on a different serverless instance — per-instance memory
 * and /tmp are NOT visible across instances — so the durable backing store is
 * now a shared KV store (see kv.ts): the POST writes job snapshots there and a
 * follow-up poll on ANY instance reads the same state. Completed jobs contain
 * only the AC3 fields plus provenance metadata — no raw HTML is ever
 * persisted (AC9).
 *
 * When no KV binding is configured (local dev, tests) the store degrades to
 * the previous behavior: module-level Maps plus a JSON disk cache that
 * survives warm recycling, so the stale-cache fallback (AC6/AC10) still works.
 * KV errors never fail a request — reads fall through to the local layers.
 *
 * Server-only module; never import from client code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CollectJob } from "@/lib/collect/types";
import { CACHE_TTL_MS, isFreshCompleted } from "@/lib/collect/types";
import { getSharedKv, type SharedKv } from "@/lib/collect/kv";

const JOBS_TTL_MS = 60 * 60 * 1000; // keep polled job ids answerable for 1 h
const KV_TTL_S = Math.ceil(JOBS_TTL_MS / 1000);

function defaultCacheDir(): string {
  if (process.env.COLLECT_CACHE_DIR) return process.env.COLLECT_CACHE_DIR;
  // Serverless filesystems are read-only except /tmp (see event-store.ts).
  // With KV configured this dir is only the in-run scratch; without KV it is
  // the whole durable layer (single warm instance).
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "/tmp/reemco-collect";
  }
  return join(process.cwd(), ".collect-cache");
}

export const COLLECT_CACHE_DIR = defaultCacheDir();

/** In-memory job registry for the current warm instance (first-tier cache). */
const jobs = new Map<string, CollectJob>();
/** Product id -> in-flight job id. Dedupes rapid repeat clicks (AC8). */
const inflight = new Map<string, string>();
/** Product id -> most recent completed job (any age; freshness is checked on read). */
const lastCompleted = new Map<string, CollectJob>();

function cacheFile(dir = COLLECT_CACHE_DIR): string {
  return join(dir, "completed-jobs.json");
}

/**
 * Per-job snapshot file (jobId -> job), written on every subtask status change
 * and read through by getJob(). Only used when no KV binding exists — shared KV
 * then takes over cross-instance visibility (REEA-92).
 */
function jobSnapshotsFile(dir = COLLECT_CACHE_DIR): string {
  return join(dir, "job-snapshots.json");
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function readJsonFile<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return {} as T;
  }
}

function persistSnapshot(job: CollectJob, dir = COLLECT_CACHE_DIR): void {
  try {
    const all = readJsonFile<Record<string, CollectJob>>(jobSnapshotsFile(dir));
    all[job.jobId] = job;
    writeJsonFile(jobSnapshotsFile(dir), all);
  } catch {
    /* best-effort */
  }
}

function persistLockedProduct(
  productId: string,
  job: CollectJob,
  dir = COLLECT_CACHE_DIR,
): void {
  try {
    const all = readJsonFile<Record<string, CollectJob>>(cacheFile(dir));
    all[productId] = job;
    writeJsonFile(cacheFile(dir), all);
  } catch {
    /* cache persistence is best-effort; live collection still works */
  }
}

function readPersisted(dir = COLLECT_CACHE_DIR): Record<string, CollectJob> {
  return readJsonFile<Record<string, CollectJob>>(cacheFile(dir));
}

/* ---------- shared-KV keys (REEA-92) ---------- */

const jobKey = (jobId: string) => `collect:job:${jobId}`;
const doneKey = (productId: string) => `collect:done:${productId}`;
const inflightKey = (productId: string) => `collect:inflight:${productId}`;

function asJob(value: unknown): CollectJob | undefined {
  if (!value || typeof value !== "object") return undefined;
  const job = value as CollectJob;
  return typeof job.jobId === "string" && Array.isArray(job.subtasks)
    ? job
    : undefined;
}

function parseJob(raw: string | null): CollectJob | undefined {
  if (!raw) return undefined;
  try {
    return asJob(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function createJob(productId: string): Promise<CollectJob> {
  const job: CollectJob = {
    jobId: randomUUID(),
    productId,
    status: "collecting",
    mode: "live",
    startedAt: new Date().toISOString(),
    subtasks: [],
    offers: [],
  };
  jobs.set(job.jobId, job);
  inflight.set(productId, job.jobId);
  const kv = getSharedKv();
  if (kv) {
    // Short TTL: the pointer only exists to dedupe near-simultaneous starts;
    // a stale pointer is harmless because readers verify the job status.
    await kv.set(inflightKey(productId), job.jobId, 60);
  }
  return job;
}

export async function getJob(jobId: string): Promise<CollectJob | undefined> {
  const kv: SharedKv | null = getSharedKv();
  if (kv) {
    // Shared KV is the cross-instance source of truth; always read through so
    // an instance holding an older copy still sees the runner's newest write.
    const job = parseJob(await kv.get(jobKey(jobId)));
    if (job) {
      jobs.set(jobId, job);
      if (job.status !== "collecting" && inflight.get(job.productId) === jobId) {
        inflight.delete(job.productId);
      }
      return job;
    }
  }
  const mem = jobs.get(jobId);
  if (mem) return mem;
  // Read through the local snapshot file (same warm instance, post-GC or
  // recycled module state; the whole store when no KV binding exists).
  const job = asJob(readJsonFile<Record<string, CollectJob>>(jobSnapshotsFile())[jobId]);
  if (job) {
    jobs.set(jobId, job);
    return job;
  }
  return undefined;
}

/** Publishes the current job state (called on every subtask status change). */
export async function touchJob(job: CollectJob): Promise<void> {
  jobs.set(job.jobId, job);
  const kv = getSharedKv();
  if (kv) {
    await kv.set(jobKey(job.jobId), JSON.stringify(job), KV_TTL_S);
    return;
  }
  persistSnapshot(job);
}

export async function getInflightJobId(productId: string): Promise<string | undefined> {
  const kv = getSharedKv();
  if (kv) {
    // Cross-instance dedupe (AC8): another instance's in-flight run counts too.
    const id = (await kv.get(inflightKey(productId))) ?? undefined;
    if (id) return id;
  }
  return inflight.get(productId);
}

/**
 * Cache-first entry used by POST /api/products/:id/collect: returns the fresh
 * completed job for this product when one exists (AC5), otherwise undefined.
 */
export async function findFreshCompleted(
  productId: string,
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL_MS,
  dir = COLLECT_CACHE_DIR,
): Promise<CollectJob | undefined> {
  const mem = lastCompleted.get(productId);
  if (mem && isFreshCompleted(mem, now, ttlMs)) return mem;
  const kv = getSharedKv();
  if (kv) {
    // Any instance's completed run answers for all of them.
    const shared = parseJob(await kv.get(doneKey(productId)));
    if (shared && isFreshCompleted(shared, now, ttlMs)) {
      jobs.set(shared.jobId, shared);
      lastCompleted.set(productId, shared);
      return shared;
    }
  }
  // Fall back to the persisted disk cache (survives warm recycling without KV).
  const persisted = readPersisted(dir)[productId];
  if (persisted && isFreshCompleted(persisted, now, ttlMs)) {
    jobs.set(persisted.jobId, persisted);
    lastCompleted.set(productId, persisted);
    return persisted;
  }
  return undefined;
}

/** Most recent completed job for the product, any age (stale-cache fallback, AC6). */
export async function findLastCompleted(
  productId: string,
  dir = COLLECT_CACHE_DIR,
): Promise<CollectJob | undefined> {
  const mem = lastCompleted.get(productId);
  if (mem) return mem;
  const kv = getSharedKv();
  if (kv) {
    const shared = parseJob(await kv.get(doneKey(productId)));
    if (shared) {
      jobs.set(shared.jobId, shared);
      lastCompleted.set(productId, shared);
      return shared;
    }
  }
  const persisted = readPersisted(dir)[productId];
  if (persisted) {
    jobs.set(persisted.jobId, persisted);
    lastCompleted.set(productId, persisted);
    return persisted;
  }
  return undefined;
}

/** Marks a job terminal, releases the in-flight slot, and caches it if complete. */
export async function finishJob(
  job: CollectJob,
  dir = COLLECT_CACHE_DIR,
  now: number = Date.now(),
): Promise<void> {
  // Preserve an explicit finishedAt (callers may backdate it to exercise the
  // cache-freshness rule); stamp only when the job has none.
  if (!job.finishedAt) job.finishedAt = new Date(now).toISOString();
  if (inflight.get(job.productId) === job.jobId) inflight.delete(job.productId);
  if (job.status === "complete") {
    lastCompleted.set(job.productId, job);
    jobs.set(job.jobId, job);
    const kv = getSharedKv();
    if (kv) {
      await kv.set(doneKey(job.productId), JSON.stringify(job), KV_TTL_S);
    } else {
      persistLockedProduct(job.productId, job, dir);
    }
  }
}

/** Periodic GC of old jobs (bounded memory on warm instances). */
export async function pruneOldJobs(
  now: number = Date.now(),
  ttlMs = JOBS_TTL_MS,
  dir = COLLECT_CACHE_DIR,
): Promise<void> {
  for (const [id, job] of jobs) {
    const t = new Date(job.finishedAt ?? job.startedAt).getTime();
    if (!Number.isNaN(t) && now - t > ttlMs) jobs.delete(id);
  }
  if (getSharedKv()) return; // KV entries expire by TTL; nothing to rewrite
  const persisted = readPersisted(dir);
  let changed = false;
  for (const [productId, job] of Object.entries(persisted)) {
    const t = new Date(job.finishedAt ?? job.startedAt).getTime();
    if (!Number.isNaN(t) && now - t > ttlMs) {
      delete persisted[productId];
      changed = true;
    }
  }
  if (changed) {
    try {
      writeJsonFile(cacheFile(dir), persisted);
    } catch {
      /* best-effort */
    }
  }
}

/** Test/admin helper: clear all in-memory state and the persisted cache. */
export function resetStoreForTests(dir = COLLECT_CACHE_DIR): void {
  jobs.clear();
  inflight.clear();
  lastCompleted.clear();
  try {
    rmSync(cacheFile(dir), { force: true });
  } catch {
    /* nothing to clean */
  }
}
