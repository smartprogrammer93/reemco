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
 * REEA-866 — the REEA-264 per-lane SC exception (SC_LANE_TIMEOUT_MS = 2 s,
 * applied via laneCeilingFor) is RETIRED: Sultan Center rides the shared
 * per-retailer budget again. The measured reason the 2 s cap existed — SC as
 * last arranger gating the full-set render — is obsolete under the
 * completion-budget staged render (REEA-693/756): the page finalizes on its
 * own clock and late rows fold in through the follow-up feed, so a slow lane
 * can no longer gate anything. What the cap DID do on the live edge was
 * abort most SC rounds: the storefront's mobile/api/search answers in
 * ~1.4–3.5 s (median ~3 s, 13 live samples, REEA-866), so a 2 s window cut
 * the phrase round AND the REEA-290 retry (its own 2 s window) — Sultan
 * Center served 4 offers in W37 (REEA-861 metrics-read-1) while every other
 * adapter served 1,473–20,180. On the shared 4 s budget every measured SC
 * round-trip (max 3.54 s) completes.
 */
export const SOFT_CEILING_MS = 6 * 1000; // render arrived offers, keep chips
export const OVERALL_BUDGET_MS = 10 * 1000; // hard ceiling

/**
 * REEA-870 — staleness window for a job whose status still reads "collecting".
 * A live run cannot outlast OVERALL_BUDGET_MS (the runner races every scrape
 * against the remaining budget and its tail always finalizes the job), so a
 * collecting job older than 3 budgets has no living runner: its serverless
 * invocation died (recycle, deploy, aborted render) before the tail could
 * write a terminal state. Left alone, the job stays "collecting" forever and
 * every later visitor dedupes onto it — the infinite "Checking …" spinner.
 */
export const INFLIGHT_STALE_MS = 3 * OVERALL_BUDGET_MS;

/** True when a still-"collecting" job is past the point any live runner could exist. */
export function isStaleCollectingJob(
  job: CollectJob,
  now: number = Date.now(),
  staleMs: number = INFLIGHT_STALE_MS,
): boolean {
  if (job.status !== "collecting") return false;
  const t = new Date(job.startedAt).getTime();
  if (Number.isNaN(t)) return false; // cannot judge age — do not reap
  return now - t > staleMs;
}

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
