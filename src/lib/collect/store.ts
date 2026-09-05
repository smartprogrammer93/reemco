/**
 * REEA-84 W1 — collection job store (T1).
 *
 * Jobs live for the lifetime of a collection run (<=25 s) plus a short-TTL
 * cache of the last completed job per product (AC5, 10 min). Storage is a
 * module-level Map (per serverless warm instance) with completed jobs
 * persisted to a JSON file so the stale-cache fallback (AC6/AC10) survives
 * warm recycling on Vercel. Completed jobs contain only the AC3 fields plus
 * provenance metadata — no raw HTML is ever persisted (AC9).
 *
 * Server-only module; never import from client code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CollectJob } from "@/lib/collect/types";
import { CACHE_TTL_MS, isFreshCompleted } from "@/lib/collect/types";

const JOBS_TTL_MS = 60 * 60 * 1000; // keep polled job ids answerable for 1 h

function defaultCacheDir(): string {
  if (process.env.COLLECT_CACHE_DIR) return process.env.COLLECT_CACHE_DIR;
  // Serverless filesystems are read-only except /tmp (see event-store.ts).
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "/tmp/reemco-collect";
  }
  return join(process.cwd(), ".collect-cache");
}

export const COLLECT_CACHE_DIR = defaultCacheDir();

/** In-memory job registry for the current warm instance. */
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
 * and read through by getJob(). Serverless filesystems are per warm instance,
 * so this narrows — but does not eliminate — cross-instance visibility of an
 * in-flight job; the client hook re-starts a collection once on an unknown
 * jobId as the user-visible fallback (see REEA-88 comment / KV follow-up).
 */
function jobSnapshotsFile(dir = COLLECT_CACHE_DIR): string {
  return join(dir, "job-snapshots.json");
}

function persistSnapshot(job: CollectJob, dir = COLLECT_CACHE_DIR): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = jobSnapshotsFile(dir);
    let all: Record<string, CollectJob> = {};
    try {
      all = JSON.parse(readFileSync(file, "utf8")) as Record<string, CollectJob>;
    } catch {
      /* first write — start over */
    }
    all[job.jobId] = job;
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, file);
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
    mkdirSync(dir, { recursive: true });
    const file = cacheFile(dir);
    let all: Record<string, CollectJob> = {};
    try {
      all = JSON.parse(readFileSync(file, "utf8")) as Record<string, CollectJob>;
    } catch {
      /* first write or unreadable file — start over */
    }
    all[productId] = job;
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, file);
  } catch {
    /* cache persistence is best-effort; live collection still works */
  }
}

function readPersisted(dir = COLLECT_CACHE_DIR): Record<string, CollectJob> {
  try {
    return JSON.parse(readFileSync(cacheFile(dir), "utf8")) as Record<
      string,
      CollectJob
    >;
  } catch {
    return {};
  }
}

export function createJob(productId: string): CollectJob {
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
  return job;
}

export function getJob(jobId: string): CollectJob | undefined {
  const mem = jobs.get(jobId);
  if (mem) return mem;
  // Read through the snapshot file (same warm instance, post-GC or recycled
  // module state).
  try {
    const all = JSON.parse(
      readFileSync(jobSnapshotsFile(), "utf8"),
    ) as Record<string, CollectJob>;
    const job = all[jobId];
    if (job) {
      jobs.set(jobId, job);
      return job;
    }
  } catch {
    /* no snapshot file yet */
  }
  return undefined;
}

/** Writes the in-memory job and its snapshot to disk (called on state changes). */
export function touchJob(job: CollectJob): void {
  jobs.set(job.jobId, job);
  persistSnapshot(job);
}

export function getInflightJobId(productId: string): string | undefined {
  return inflight.get(productId);
}

/**
 * Cache-first entry used by POST /api/products/:id/collect: returns the fresh
 * completed job for this product when one exists (AC5), otherwise undefined.
 */
export function findFreshCompleted(
  productId: string,
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL_MS,
  dir = COLLECT_CACHE_DIR,
): CollectJob | undefined {
  const mem = lastCompleted.get(productId);
  if (mem && isFreshCompleted(mem, now, ttlMs)) return mem;
  // Fall back to the persisted cache (survives warm recycling).
  const persisted = readPersisted(dir)[productId];
  if (persisted && isFreshCompleted(persisted, now, ttlMs)) {
    jobs.set(persisted.jobId, persisted);
    lastCompleted.set(productId, persisted);
    return persisted;
  }
  return undefined;
}

/** Most recent completed job for the product, any age (stale-cache fallback, AC6). */
export function findLastCompleted(
  productId: string,
  dir = COLLECT_CACHE_DIR,
): CollectJob | undefined {
  const mem = lastCompleted.get(productId);
  if (mem) return mem;
  const persisted = readPersisted(dir)[productId];
  if (persisted) {
    jobs.set(persisted.jobId, persisted);
    lastCompleted.set(productId, persisted);
    return persisted;
  }
  return undefined;
}

/** Marks a job terminal, releases the in-flight slot, and caches it if complete. */
export function finishJob(
  job: CollectJob,
  dir = COLLECT_CACHE_DIR,
  now: number = Date.now(),
): void {
  // Preserve an explicit finishedAt (callers may backdate it to exercise the
  // cache-freshness rule); stamp only when the job has none.
  if (!job.finishedAt) job.finishedAt = new Date(now).toISOString();
  if (inflight.get(job.productId) === job.jobId) inflight.delete(job.productId);
  if (job.status === "complete") {
    lastCompleted.set(job.productId, job);
    jobs.set(job.jobId, job);
    persistLockedProduct(job.productId, job, dir);
  }
}

/** Periodic GC of old jobs (bounded memory on warm instances). */
export function pruneOldJobs(
  now: number = Date.now(),
  ttlMs = JOBS_TTL_MS,
  dir = COLLECT_CACHE_DIR,
): void {
  for (const [id, job] of jobs) {
    const t = new Date(job.finishedAt ?? job.startedAt).getTime();
    if (!Number.isNaN(t) && now - t > ttlMs) jobs.delete(id);
  }
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
      mkdirSync(dir, { recursive: true });
      const tmp = `${cacheFile(dir)}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(persisted));
      renameSync(tmp, cacheFile(dir));
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
