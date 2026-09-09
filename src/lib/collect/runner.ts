/**
 * REEA-84 W1 — collection job runner (T2) + retry (T6).
 *
 * Fans out one scrape per retailer offer with `Promise.allSettled`, bounded by
 * per-adapter 4 s timeouts (inside the scraper) and a 10 s overall budget
 * (this watchdog, REEA-95 realtime-policy §5). Subtask status is written as
 * the run progresses so the polling endpoint serves real per-retailer states
 * — progress is never synthetic. Offers are appended per retailer as they
 * land, so staged arrival survives the poll. Only the AC fields plus
 * provenance are kept.
 *
 * Feasibility note (per plan §1.1): the direct-fetch adapters are lightweight
 * (no headless browser), so the fan-out fits the function budget; the route
 * still sets `maxDuration = 60` as headroom on platforms that support it —
 * the budgets above are enforced here regardless.
 */
import type { CollectJob, LiveOffer, RetailerSubtask } from "@/lib/collect/types";
import { OVERALL_BUDGET_MS } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";
import { scrapeOffer, subtaskFor, type FetchImpl } from "@/lib/collect/scraper";
import {
  createJob,
  findLastCompleted,
  finishJob,
  getInflightJobId,
  getJob,
  touchJob,
} from "@/lib/collect/store";

export interface StartResult {
  job: CollectJob;
  /** True when an in-flight job for this product was reused (dedupe). */
  deduped: boolean;
  /** Kept for API-shape stability; the server always collects live now. */
  servedFromCache: boolean;
}

/** Snapshot handed to a stage listener: shallow copy so later in-place
 *  mutation of the running job never rewrites an already-flushed chunk. */
function stageSnapshot(job: CollectJob): CollectJob {
  return { ...job, subtasks: [...job.subtasks], offers: [...job.offers] };
}

/**
 * Entry point for POST /api/products/:id/collect. Returns in well under 300 ms:
 * it only creates/looks up registry entries; the scrape itself is scheduled by
 * the caller via `after()` (runCollectionJob) so the response is never blocked.
 *
 * REEA-95 realtime-policy §4 — every product view ALWAYS collects live: the
 * server cache is no longer a serving path. The only labeled repeat cache is
 * the client's same-tab session snapshot (see useCollection). `force` remains
 * accepted (and is now the default behavior) so older clients keep working.
 */
export async function startCollection(
  product: NormalizedProduct,
  opts: { force?: boolean } = {},
): Promise<StartResult> {
  void opts; // always-live: `force` is accepted but no longer changes anything
  // Dedupe rapid repeat clicks on the same product by in-flight job (shared
  // across instances through the KV store, REEA-92).
  const inflightId = await getInflightJobId(product.productId);
  if (inflightId) {
    const existing = await getJob(inflightId);
    if (existing && existing.status === "collecting") {
      return { job: existing, deduped: true, servedFromCache: false };
    }
  }

  const job = await createJob(product.productId);
  job.subtasks = product.offers.map((o) => subtaskFor(o));
  // Snapshot before responding so a poll on another instance finds it in the
  // shared store (REEA-92).
  await touchJob(job);
  return { job, deduped: false, servedFromCache: false };
}

/** Staged product collection for the /product/... server render (REEA-248). */
export interface StagedProductCollection {
  jobId: string;
  /** Resolves with the snapshot as soon as the FIRST retailer answer lands
   *  (or the run turns terminal with none) — the detail-page first offer. */
  firstStage: Promise<CollectJob>;
  /** Resolves with the terminal snapshot when the whole run settles. */
  finalStage: Promise<CollectJob>;
}

/**
 * REEA-248 — server-side staged collection for the product detail page, the
 * per-product sibling of the results-page streaming (REEA-178): the run is
 * started during the server render, and `firstStage` flushes the first landed
 * retailer offer into the streamed HTML so a shopper sees a real price with no
 * click and without waiting for hydration. The job rides the shared KV store
 * exactly like the POST/poll path, so the client can CONTINUE the same job by
 * polling its id — no second POST on first paint (AC2). Dedupe, the per-
 * retailer 4 s ceilings and the overall budget all live in runCollection and
 * apply unchanged. The returned promises never reject: a stage that cannot
 * land settles on the terminal snapshot instead, so the boundary degrades to
 * the existing Collect-now fallback rather than blanking the panel.
 */
export async function startProductCollectionStaged(
  product: NormalizedProduct,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<StagedProductCollection> {
  const { job, deduped } = await startCollection(product);
  let resolveFirst: ((job: CollectJob) => void) | null = null;
  const firstStage = new Promise<CollectJob>((resolve) => {
    resolveFirst = resolve;
  });
  const onStage = (snap: CollectJob) => {
    resolveFirst?.(snap);
  };
  // Dedupe hit (REEA-92): an earlier request already owns this in-flight run —
  // attach its current snapshot and let the client's polling converge; never
  // fan out a duplicate scrape of the same retailers.
  const run = deduped
    ? Promise.resolve(stageSnapshot(job))
    : runCollection(job, product, { fetchImpl: opts.fetchImpl, onStage }).then(
        (final) => stageSnapshot(final),
        () => stageSnapshot(job), // bounded: the runner swallows failures itself
      );
  const finalStage = run.then((snap) => {
    resolveFirst?.(snap); // a dedupe/single-flush run still feeds stage one
    return snap;
  });
  return { jobId: job.jobId, firstStage, finalStage };
}

/**
 * Execute the fan-out for a job. Fire-and-forget from the POST route via
 * `after()`; mutates the shared job object in place so GET polling sees
 * partial progress and partial offers.
 */
export async function runCollection(
  job: CollectJob,
  product: NormalizedProduct,
  opts: { fetchImpl?: FetchImpl; overallBudgetMs?: number; now?: number; onStage?: (job: CollectJob) => void } = {},
): Promise<CollectJob> {
  const budgetMs = opts.overallBudgetMs ?? OVERALL_BUDGET_MS;
  const retailers = product.offers.map((o) => ({
    merchant: o.merchant,
    url: o.url,
    currency: o.currency,
    wasPrice: o.wasPrice,
    // Title for the retailer-search fallback (stale seed URLs, REEA-67).
    titleQuery: product.title,
  }));

  const scrape = async (retailer: (typeof retailers)[number], sub: RetailerSubtask) => {
    if (job.status !== "collecting") return [] as LiveOffer[];
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
    await touchJob(job); // publish subtask progress for the polling endpoint (AC2)
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
        if (offers === null) {
          // Watchdog already marked the subtask — publish the state so a
          // staged page flush never waits on a hung scrape.
          opts.onStage?.(stageSnapshot(job));
          return;
        }
        job.offers.push(...offers);
        opts.onStage?.(stageSnapshot(job));
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
      const previous = await findLastCompleted(job.productId);
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
        const previous = await findLastCompleted(job.productId);
        if (previous && previous.jobId !== job.jobId) job.previousJobId = previous.jobId;
      }
    }
  } catch (err) {
    clearTimeout(budgetTimer);
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    await finishJob(job);
    await touchJob(job);
    // Final flush: guarantees a staged consumer always gets a terminal snapshot
    // even when every retailer failed (empty cascade must still render).
    opts.onStage?.(stageSnapshot(job));
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
  opts: { fetchImpl?: FetchImpl; now?: number } = {},
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
    const outcome = await scrapeOffer({ ...offer, titleQuery: product.title }, {
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
    const previous = await findLastCompleted(job.productId);
    if (previous && previous.jobId !== job.jobId) job.previousJobId = previous.jobId;
  } else {
    job.error = undefined;
  }
  await finishJob(job);
  await touchJob(job);
  return job;
}

/** Sort helper: best (lowest) price first for rendering. */
export function sortLiveOffers(offers: LiveOffer[]): LiveOffer[] {
  return [...offers].sort((a, b) => a.price - b.price);
}
