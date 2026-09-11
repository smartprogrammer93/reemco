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

export const CACHE_TTL_MS = 10 * 60 * 1000; // labeled-repeat freshness window
/**
 * REEA-95 realtime-policy §5 latency budget: each adapter gets its own 4 s
 * timeout so one slow retailer cannot push the page past the full-set budget;
 * 6 s soft ceiling renders what arrived while stragglers keep in-progress
 * chips; 10 s hard ceiling stops waiting entirely.
 */
export const PER_RETAILER_TIMEOUT_MS = 4 * 1000; // per-adapter, independent
/**
 * REEA-264 — Sultan Center lane ceiling, the documented per-lane exception
 * to the shared 4 s budget. Tail attribution on the deployed edge (REEA-257):
 * SC content lands avg ~3.5-3.6 s — inside the shared budget, so nothing cut
 * it — yet as last arranger it kept gating the full-set render (p90 stuck at
 * ~4.9 s against the 4 s bar). The lane rides its own ~2 s effective cap:
 * whatever the storefront answers by then flushes with the progressive
 * stages; a cut hop keeps settling behind the finalized response into the
 * converged tail / follow-up feed (REEA-398), never a bundled snapshot.
 * Every other adapter keeps PER_RETAILER_TIMEOUT_MS unchanged.
 */
export const SC_LANE_TIMEOUT_MS = 2 * 1000; // Sultan Center lane only
export const SOFT_CEILING_MS = 6 * 1000; // render arrived offers, keep chips
export const OVERALL_BUDGET_MS = 10 * 1000; // hard ceiling

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
