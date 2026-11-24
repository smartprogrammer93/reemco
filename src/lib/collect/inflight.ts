/**
 * REEA-1063 — process-wide admission control for live collection runs.
 *
 * The per-caller rate limits bound how often ONE client can request work; they
 * do not bound how many DISTINCT products are scraped at once. Without a cap,
 * N product ids (one client opening many pages, or many clients) fan out N
 * retailer scrapes on the same process — the egress amplification the
 * REEA-1052 review warned about, arriving through a different door.
 *
 * Contract:
 *  - Hard ceiling: at most MAX_INFLIGHT_COLLECTIONS concurrent `runCollection`
 *    bodies per process. Deployment semantics mirror the REEA-37 limiter: the
 *    counter is per-process memory, so on a multi-worker host each worker
 *    admits its own budget; the shared-KV rate limit (REEA-827) is what bounds
 *    the fleet. Never document this number as a deployment-wide ceiling.
 *  - FIFO queue: excess runs wait for a slot instead of being rejected, so a
 *    queued job still completes. The job is already persisted as "collecting"
 *    by startCollection, so polling clients see honest state while they wait.
 *  - Bounded wait (ADMISSION_WAIT_MS): if no slot frees inside one run budget
 *    the run is admitted anyway. Deliberate fail-open — blocking a shopper's
 *    run forever to protect a soft ceiling is worse than briefly exceeding it,
 *    and the wait stays under INFLIGHT_STALE_MS so a repeat click cannot reap
 *    the queued job as dead.
 *  - Slots are released in a finally, so a thrown run cannot leak capacity.
 *
 * REEA-1133 — page renders (the /results and /product fan-outs) hold the SAME
 * counter through `tryAcquireCollectionSlot()`, which is bounded and
 * FAIL-CLOSED: a render that cannot be admitted in time serves a cached or
 * pending shell instead of fanning out. Before this, the cap only guarded
 * runner jobs, so N distinct page queries fanned out N×15 retailer lanes
 * regardless of the ceiling.
 *
 * Env override: REEMCO_MAX_INFLIGHT_COLLECTIONS (default 8).
 */

/** Default concurrent runs per process. */
const DEFAULT_MAX_INFLIGHT = 8;

/** Longest a run waits for a slot before being admitted anyway (fail-open). */
export const ADMISSION_WAIT_MS = 10_000;

/**
 * REEA-1133 — page-render admission is bounded and FAIL-CLOSED: a render that
 * cannot get a slot inside this window does not fan out at all, so a burst of
 * distinct queries queues behind the same ceiling instead of multiplying the
 * retailer fan-out. The runner keeps its fail-open wait above (a queued job is
 * already persisted and must still complete); a render can degrade honestly
 * (cached/pending shell) instead of holding the shopper's stream open.
 * Kept well under INFLIGHT_STALE_MS (30 s) so a render wait never looks like a
 * dead run.
 */
export const RENDER_ADMISSION_WAIT_MS = readWait("REEMCO_RENDER_ADMISSION_WAIT_MS", 4_000);
/**
 * REEA-1133 — how long a render-deferred run waits for a slot BEHIND the
 * response. The render has already returned its pending/cached shell by then,
 * so this wait only bounds the queue depth (bounded, fail-closed: no slot in
 * this window means the run is dropped and the next request retries live).
 */
export const RENDER_DEFERRED_WAIT_MS = readWait("REEMCO_RENDER_DEFERRED_WAIT_MS", 20_000);

function readCap(): number {
  const raw = Number(process.env.REEMCO_MAX_INFLIGHT_COLLECTIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_INFLIGHT;
}

function readWait(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** Per-process ceiling on concurrently running collection bodies. */
export const MAX_INFLIGHT_COLLECTIONS = readCap();

interface Waiter {
  grant: () => void;
  /** Fail-open waiters hold their own expiry timer; reset clears them. */
  timer?: ReturnType<typeof setTimeout>;
}

let active = 0;
const waiters: Waiter[] = [];

/** Test/admin helper: currently admitted collection runs in this process. */
export function inflightCollectionCount(): number {
  return active;
}

/**
 * Acquire an admission slot for one collection run. Resolves once the caller
 * may fan out; pair every call with `releaseCollectionSlot()` in a finally.
 */
export async function acquireCollectionSlot(): Promise<void> {
  if (active < MAX_INFLIGHT_COLLECTIONS) {
    active += 1;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    let settled = false;
    const waiter: Waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        // A release handed its slot straight to this waiter; `active` is
        // unchanged, so release must not decrement for it.
        resolve();
      },
    };
    waiters.push(waiter);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // No slot freed in time — admit anyway (fail-open) and stop occupying a
      // queue position a later release would otherwise hand a phantom slot to.
      const at = waiters.indexOf(waiter);
      if (at !== -1) waiters.splice(at, 1);
      active += 1;
      resolve();
    }, ADMISSION_WAIT_MS);
    waiter.timer = timer;
  });
  clearTimeout(timer);
}

/**
 * REEA-1133 — bounded, FAIL-CLOSED admission for page renders.
 *
 * Same process-wide ceiling as `acquireCollectionSlot()` (one shared counter,
 * so page renders and runner jobs cannot each spend a full budget), but a
 * caller that does not get a slot inside `waitMs` resolves `null` instead of
 * being admitted anyway. The render path then degrades honestly (a cached or
 * pending shell) and the fan-out is either deferred behind the response or
 * dropped — distinct queries queue, they never multiply.
 *
 * On success the returned release MUST be called exactly once (pair it with
 * the run's settled tail). A handed-over slot does not change `active`, so
 * releasing it is the same decrement-or-hand-over path as the fail-open form.
 */
export async function tryAcquireCollectionSlot(waitMs: number = RENDER_ADMISSION_WAIT_MS): Promise<(() => void) | null> {
  if (active < MAX_INFLIGHT_COLLECTIONS) {
    active += 1;
    return releaseCollectionSlot;
  }
  if (!(waitMs > 0)) return null;

  return await new Promise<(() => void) | null>((resolve) => {
    let settled = false;
    const waiter: Waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        // A granted waiter must not keep its expiry timer alive (it would
        // otherwise fire up to `waitMs` later and no-op).
        if (waiter.timer) clearTimeout(waiter.timer);
        // The releasing holder handed its slot straight to this waiter;
        // `active` is unchanged, so the paired release decrements it.
        resolve(releaseCollectionSlot);
      },
    };
    waiters.push(waiter);
    waiter.timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Fail closed: leave the queue without taking capacity, so a later
      // release goes to the next waiter (or decrements the real count).
      const at = waiters.indexOf(waiter);
      if (at !== -1) waiters.splice(at, 1);
      resolve(null);
    }, waitMs);
  });
}

/** Release a slot acquired through `acquireCollectionSlot()`. */
export function releaseCollectionSlot(): void {
  const next = waiters.shift();
  if (next) {
    next.grant();
    return;
  }
  active = Math.max(0, active - 1);
}

/** Test helper: clear admission state (only call while no run is pending). */
export function resetCollectionInflightForTests(): void {
  for (const waiter of waiters) clearTimeout(waiter.timer);
  active = 0;
  waiters.length = 0;
}
