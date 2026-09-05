/**
 * REEA-84 W1 — collection job runner (T2) + retry (T6).
 *
 * Fans out one scrape per retailer offer with `Promise.allSettled`, bounded by
 * a 20 s per-retailer timeout (inside the scraper) and a 25 s overall budget
 * (this watchdog). Subtask status is written as the run progresses so the
 * polling endpoint serves real per-retailer states (AC2) — progress is never
 * synthetic. Only the fields in AC3 plus provenance are kept (AC9).
 *
 * Feasibility note (per plan §1.1): the direct-fetch adapters are lightweight
 * (no headless browser), so the fan-out fits the 25 s function budget; the
 * documented fallbacks (maxDuration raise / two-phase design) are not needed.
 * The route still sets `maxDuration = 60` as headroom on platforms that
 * support it — the user-visible 30 s contract is enforced here regardless.
 */
import type { CollectJob, LiveOffer, RetailerSubtask } from "@/lib/collect/types";
import { OVERALL_BUDGET_MS } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";
import { scrapeOffer, subtaskFor } from "@/lib/collect/scraper";
import {
  createJob,
  findFreshCompleted,
  findLastCompleted,
  finishJob,
  getInflightJobId,
  getJob,
} from "@/lib/collect/store";

export interface StartResult {
  job: CollectJob;
  /** True when an in-flight job for this product was reused (AC8 dedupe). */
  deduped: boolean;
  /** True when a fresh completed job was served from cache (AC5). */
  servedFromCache: boolean;
}

/**
 * Entry point for POST /api/products/:id/collect. Returns in well under 300 ms:
 * it only creates/looks up registry entries; the scrape itself is scheduled by
 * the caller via `after()` (runCollectionJob) so the response is never blocked.
 */
export function startCollection(
  product: NormalizedProduct,
  opts: { force?: boolean } = {},
): StartResult {
  // AC8: dedupe rapid repeat clicks on the same product by in-flight job.
  const inflightId = getInflightJobId(product.productId);
  if (inflightId) {
    const existing = getJob(inflightId);
    if (existing && existing.status === "collecting") {
      return { job: existing, deduped: true, servedFromCache: false };
    }
  }

  // AC5 freshness rule: a completed collection <=10 min old is served as cached.
  if (!opts.force) {
    const cached = findFreshCompleted(product.productId);
    if (cached) {
      // Labeled as cached for provenance rendering (AC4/AC5).
      cached.mode = "cache";
      return { job: cached, deduped: false, servedFromCache: true };
    }
  }

  const job = createJob(product.productId);
  job.subtasks = product.offers.map((o) => subtaskFor(o));
  return { job, deduped: false, servedFromCache: false };
}

/**
 * Execute the fan-out for a job. Fire-and-forget from the POST route via
 * `after()`; mutates the shared job object in place so GET polling sees
 * partial progress and partial offers.
 */
export async function runCollection(
  job: CollectJob,
  product: NormalizedProduct,
  opts: { fetchImpl?: typeof fetch; overallBudgetMs?: number; now?: number } = {},
): Promise<CollectJob> {
  const budgetMs = opts.overallBudgetMs ?? OVERALL_BUDGET_MS;
  const startedAt = opts.now ?? Date.now();
  const retailers = product.offers.map((o) => ({
    merchant: o.merchant,
    url: o.url,
    currency: o.currency,
    wasPrice: o.wasPrice,
  }));

  const scrape = async (retailer: (typeof retailers)[number], sub: RetailerSubtask) => {
    if (job.status !== "collecting") return { offers: [] as LiveOffer[], error: "Job already settled" };
    sub.status = "collecting";
    sub.startedAt = new Date().toISOString();
    const outcome = await scrapeOffer(retailer, {
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    });
    sub.finishedAt = new Date().toISOString();
    sub.offersFound = outcome.offers.length;
    if (outcome.timedOut) {
      sub.status = "timeout";
      sub.error = outcome.error;
    } else if (outcome.error) {
      sub.status = "failed";
      sub.error = outcome.error;
    } else {
      sub.status = "done";
    }
    return outcome.offers;
  };

  // Overall budget watchdog (AC7): subtasks still pending when the budget
  // expires are marked timeout, even if their fetch hangs.
  const budgetTimer = setTimeout(() => {
    for (const sub of job.subtasks) {
      if (sub.status === "pending" || sub.status === "collecting") {
        sub.status = "timeout";
        sub.error = `Exceeded ${Math.round(budgetMs / 1000)}s overall budget`;
        sub.finishedAt = new Date().toISOString();
      }
    }
  }, budgetMs);

  try {
    // Wall-clock deadline: opts.now is a provenance timestamp for offers, not
    // a clock substitute — mixing it with Date.now() made remaining <= 0.
    const deadline = Date.now() + budgetMs;
    // Each scrape is raced against the remaining overall budget so a hung
    // fetch cannot stretch Promise.allSettled past the 25 s envelope (AC7).
    const results = await Promise.allSettled(
      retailers.map(async (retailer, i) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const sub = job.subtasks[i];
          if (sub.status === "pending" || sub.status === "collecting") {
            sub.status = "timeout";
            sub.error = `Exceeded ${Math.round(budgetMs / 1000)}s overall budget`;
            sub.finishedAt = new Date().toISOString();
          }
          return;
        }
        const offers = await Promise.race([
          scrape(retailer, job.subtasks[i]),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (offers === null) return; // watchdog already marked the subtask
        job.offers.push(...offers);
      }),
    );
    clearTimeout(budgetTimer);
    void results; // per-subtask state already recorded; failures are in sub.error

    const anySuccess = job.subtasks.some((s) => s.status === "done");
    const allSettled = job.subtasks.every(
      (s) => s.status === "done" || s.status === "failed" || s.status === "timeout",
    );
    if (allSettled && anySuccess) {
      job.status = "complete";
    } else if (allSettled) {
      job.status = "failed";
      job.error = "All retailers failed — no live offers could be collected";
      // Stale-cache fallback link (AC6): surface the last completed collection.
      const previous = findLastCompleted(job.productId);
      if (previous && previous.jobId !== job.jobId) job.previousJobId = previous.jobId;
    }
    // If the watchdog fired but some fetches are still pending, allSettled is
    // false — leave status "collecting"; the still-running scrape settles soon
    // after and this function's tail marks the job terminal below.
    if (job.status === "collecting") {
      const anyDone = job.offers.length > 0 || anySuccess;
      if (anyDone) job.status = "complete";
      else {
        job.status = "failed";
        job.error = "Collection did not finish within the time budget";
        const previous = findLastCompleted(job.productId);
        if (previous && previous.jobId !== job.jobId) job.previousJobId = previous.jobId;
      }
    }
  } catch (err) {
    clearTimeout(budgetTimer);
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    finishJob(job);
  }
  return job;
}

/**
 * T6: retry a single failed/timed-out retailer on a terminal job. Resets the
 * subtask, re-runs its scrape, and re-evaluates the job status. Returns the
 * updated job (client resumes polling it).
 */
export async function retryRetailer(
  job: CollectJob,
  product: NormalizedProduct,
  retailer: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<CollectJob | undefined> {
  if (job.status === "collecting") return undefined; // only terminal jobs retry
  const index = product.offers.findIndex((o) => o.merchant === retailer);
  if (index === -1) return undefined;
  const sub = job.subtasks[index];
  if (!sub) return undefined;

  job.status = "collecting";
  sub.status = "collecting";
  sub.error = undefined;
  sub.startedAt = new Date().toISOString();
  const offer = product.offers[index];
  try {
    const outcome = await scrapeOffer(offer, { fetchImpl: opts.fetchImpl, now: opts.now });
    sub.finishedAt = new Date().toISOString();
    sub.offersFound = outcome.offers.length;
    if (outcome.timedOut) {
      sub.status = "timeout";
      sub.error = outcome.error;
    } else if (outcome.error) {
      sub.status = "failed";
      sub.error = outcome.error;
    } else {
      sub.status = "done";
      // Replace any prior offers from this retailer, then add the fresh one.
      job.offers = job.offers.filter((o) => o.merchant !== retailer);
      job.offers.push(...outcome.offers);
    }
  } catch (err) {
    sub.status = "failed";
    sub.error = err instanceof Error ? err.message : String(err);
    sub.finishedAt = new Date().toISOString();
  }

  const anySuccess = job.offers.length > 0;
  job.status = anySuccess ? "complete" : "failed";
  if (job.status === "failed") {
    job.error = "All retailers failed — no live offers could be collected";
    const previous = findLastCompleted(job.productId);
    if (previous && previous.jobId !== job.jobId) job.previousJobId = previous.jobId;
  } else {
    job.error = undefined;
  }
  finishJob(job);
  return job;
}

/** Sort helper: best (lowest) price first for rendering. */
export function sortLiveOffers(offers: LiveOffer[]): LiveOffer[] {
  return [...offers].sort((a, b) => a.price - b.price);
}
