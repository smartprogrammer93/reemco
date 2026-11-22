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
 * Env override: REEMCO_MAX_INFLIGHT_COLLECTIONS (default 8).
 */

/** Default concurrent runs per process. */
const DEFAULT_MAX_INFLIGHT = 8;

/** Longest a run waits for a slot before being admitted anyway (fail-open). */
export const ADMISSION_WAIT_MS = 10_000;

function readCap(): number {
  const raw = Number(process.env.REEMCO_MAX_INFLIGHT_COLLECTIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_INFLIGHT;
}

/** Per-process ceiling on concurrently running collection bodies. */
export const MAX_INFLIGHT_COLLECTIONS = readCap();

interface Waiter {
  grant: () => void;
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
  });
  clearTimeout(timer);
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
  active = 0;
  waiters.length = 0;
}
