/**
 * REEA-84 W1 — real-time per-product collection: shared types.
 *
 * A collection job is created per product view (AC1), fans out one subtask per
 * retailer offer (T2), and is polled by the client (T3). Provenance fields
 * (retailer/domain, collected-at, live-vs-cached) ride on every offer (T5).
 */

export type SubtaskStatus = "pending" | "collecting" | "done" | "failed" | "timeout";

export type JobStatus = "collecting" | "complete" | "failed";

export interface RetailerSubtask {
  retailer: string;
  domain: string;
  status: SubtaskStatus;
  offersFound: number;
  /** Populated for failed/timeout subtasks — surfaced as the retry chip text. */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A price offer produced by a live collection, with provenance (AC4). */
export interface LiveOffer {
  merchant: string;
  domain: string;
  price: number;
  currency: string;
  url: string;
  inStock: boolean;
  wasPrice?: number;
  /** ISO 8601 collection timestamp for this offer. */
  collectedAt: string;
  /** "live" for a fresh scrape, "cache" when replayed from the short-TTL cache. */
  method: "live" | "cache";
}

export interface CollectJob {
  jobId: string;
  productId: string;
  status: JobStatus;
  /** "cache" when the POST served a fresh completed job instead of scraping. */
  mode: "live" | "cache";
  startedAt: string;
  finishedAt?: string;
  subtasks: RetailerSubtask[];
  offers: LiveOffer[];
  /** Product-level error when status === "failed" (AC6). */
  error?: string;
  /**
   * When the live run failed but a previously completed collection exists
   * (any age), its jobId is linked here so clients can render the stale-cache
   * fallback labeled with its age (AC6).
   */
  previousJobId?: string;
}

export const CACHE_TTL_MS = 10 * 60 * 1000; // AC5 freshness rule
export const PER_RETAILER_TIMEOUT_MS = 20 * 1000; // T2
export const OVERALL_BUDGET_MS = 25 * 1000; // T2 / AC7

/** True when a completed job is fresh enough to serve as cached (AC5). */
export function isFreshCompleted(
  job: CollectJob,
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL_MS,
): boolean {
  if (job.status !== "complete") return false;
  const t = new Date(job.finishedAt ?? job.startedAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t <= ttlMs;
}

/** "collected Xs ago" relative label for provenance lines (AC4). */
export function collectedAgoLabel(iso: string, now: number = Date.now()): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
