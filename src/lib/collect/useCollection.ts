"use client";

/**
 * REEA-84 W1 T4 — client collection hook, REEA-95 realtime-policy pass.
 *
 * Flow: start(productId) -> POST /api/products/:id/collect -> poll
 * GET /api/collect-jobs/:jobId every 400 ms until terminal -> expose the job
 * snapshot for rendering. The short poll interval keeps first-offer visibility
 * inside the ≤1.0 s P50 budget (realtime-policy §5). Double-clicks are deduped:
 * a start while a start or poll cycle is active is a no-op, matching the
 * server-side in-flight dedupe. retryRetailer re-runs one failed retailer and
 * resumes polling.
 *
 * Same-session repeat cache (realtime-policy §4, deliberately narrow): a
 * module-level in-memory Map holds the last completed job per product for the
 * lifetime of THIS browser tab session. Returning to the same product renders
 * that snapshot immediately, labeled "Cached — refreshed at …", while a fresh
 * collection runs in the background; the label clears when fresh data lands.
 * A hard refresh or new tab starts with an empty Map — always fully fresh,
 * never served from cache. No cookies / localStorage / cross-session ids.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectJob } from "@/lib/collect/types";

const POLL_INTERVAL_MS = 400;

/** Same-tab session snapshot cache — cleared automatically on hard refresh. */
const sessionJobs = new Map<string, CollectJob>();

/** Test/admin helper: clear the same-tab snapshot cache. */
export function resetSessionCacheForTests(): void {
  sessionJobs.clear();
}

export type CollectionPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "polling"; job: CollectJob }
  | { kind: "terminal"; job: CollectJob };

export function useCollection(productId: string, initialJob?: CollectJob | null) {
  // Same-tab repeat: render the previous completed snapshot immediately, with
  // a visible cache label that clears once fresh data lands. Without a same-tab
  // snapshot, the server-started staged snapshot (REEA-248) seeds the first
  // paint — the first offer is already visible in the served HTML, so the
  // client only CONTINUES that job by polling, never re-POSTs on mount.
  const [state, setState] = useState<CollectionPhase>(() => {
    const cached = sessionJobs.get(productId);
    if (cached) return { kind: "terminal", job: cached };
    if (initialJob) {
      return initialJob.status === "collecting"
        ? { kind: "polling", job: initialJob }
        : { kind: "terminal", job: initialJob };
    }
    return { kind: "idle" };
  });
  const [cachedNoticeAt, setCachedNoticeAt] = useState<string | null>(() => {
    const cached = sessionJobs.get(productId);
    return cached ? cached.finishedAt ?? cached.startedAt : null;
  });
  const busyRef = useRef(false); // dedupe double-clicks / effect re-runs
  const restartsRef = useRef(0); // cross-instance 404 restart budget
  const startRef = useRef<((opts?: { force?: boolean }) => Promise<void>) | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const poll = useCallback((jobId: string) => {
    const tick = async () => {
      try {
        const res = await fetch(`/api/collect-jobs/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const job = (await res.json()) as CollectJob;
          if (!mountedRef.current) return;
          if (job.status === "collecting") {
            setState({ kind: "polling", job });
            pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }
          if (job.status === "complete") sessionJobs.set(productId, job);
          setState({ kind: "terminal", job });
          setCachedNoticeAt(null); // fresh data landed — clear the cache label
          busyRef.current = false;
          return;
        }
        if (res.status === 404) {
          // Cross-instance miss (REEA-92): with the shared KV store bound, the
          // polling endpoint reads the job written by ANY instance, so a miss
          // now only happens when KV is unavailable. Re-start the collection
          // once — the freshness rule and dedupe still bound the work.
          if (restartsRef.current < 1 && mountedRef.current) {
            restartsRef.current += 1;
            busyRef.current = false;
            void startRef.current?.();
            return;
          }
          // Restart budget exhausted — the shared store could not be read
          // (KV unavailable or mid-recycling). Fall back to the synchronous
          // ?wait=1 mode, which runs the collection inside the POST invocation
          // and returns the terminal snapshot with real per-retailer subtask
          // states (AC2) — bounded by the 25s budget.
          if (mountedRef.current) {
            try {
              const waitRes = await fetch(`/api/products/${productId}/collect?wait=1`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              if (waitRes.ok) {
                const job = (await waitRes.json()) as CollectJob;
                if (mountedRef.current && job.status) {
                  if (job.status === "complete") sessionJobs.set(productId, job);
                  setState({ kind: "terminal", job });
                  setCachedNoticeAt(null);
                  busyRef.current = false;
                  return;
                }
              }
            } catch {
              /* fall through to the error state */
            }
            setState({
              kind: "terminal",
              job: {
                jobId,
                productId,
                status: "failed",
                mode: "live",
                startedAt: new Date().toISOString(),
                subtasks: [],
                offers: [],
                error: "Collection job not found — please start again.",
              },
            });
          }
          busyRef.current = false;
          return;
        }
      } catch {
        /* transient network error — keep polling */
      }
      if (mountedRef.current) {
        pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    void tick();
  }, [productId]);

  // Internal start used by both the user-facing entry point and the poll-loop
  // 404 restart. Only the user-facing path resets the restart budget, so a
  // restart chain cannot loop forever (T6).
  const doStart = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (busyRef.current) return; // dedupe double-clicks client-side too
      busyRef.current = true;
      // Background revalidation: keep a cached-labeled snapshot on screen;
      // only a cold mount shows the starting state.
      setState((prev) => (prev.kind === "idle" ? { kind: "starting" } : prev));
      try {
        const res = await fetch(`/api/products/${productId}/collect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts.force ? { force: true } : {}),
        });
        if (!res.ok) {
          busyRef.current = false;
          setState({ kind: "idle" });
          return;
        }
        const { jobId } = (await res.json()) as { jobId: string };
        poll(jobId);
      } catch {
        busyRef.current = false;
        if (mountedRef.current) setState({ kind: "idle" });
      }
    },
    [productId, poll],
  );

  const start = useCallback(
    async (opts: { force?: boolean } = {}) => {
      restartsRef.current = 0; // fresh user-initiated cycle
      await doStart(opts);
    },
    [doStart],
  );

  // Keep a stable handle to `doStart` for the poll-loop restart path (a
  // callback cannot reference itself before definition; an assignment effect
  // avoids a render-phase write).
  useEffect(() => {
    startRef.current = doStart;
  }, [doStart]);

  const retryRetailer = useCallback(
    async (retailer: string, jobId: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const res = await fetch(`/api/collect-jobs/${jobId}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retailer }),
        });
        if (res.ok) {
          const job = (await res.json()) as CollectJob;
          if (!mountedRef.current) return;
          if (job.status === "collecting") {
            setState({ kind: "polling", job });
            poll(job.jobId);
          } else {
            setState({ kind: "terminal", job });
          }
        }
      } catch {
        /* leave current state; the row still shows its failure chip */
      } finally {
        busyRef.current = false;
      }
    },
    [poll],
  );

  // REEA-248 — continue a job the SERVER render already started: same job id,
  // poll-only (no second POST on first paint, AC2). A same-tab snapshot keeps
  // its existing labeled-repeat behavior: background revalidation via POST.
  const attach = useCallback(
    (job: CollectJob) => {
      if (sessionJobs.get(productId)) {
        void startRef.current?.();
        return;
      }
      restartsRef.current = 0;
      if (job.status === "complete") sessionJobs.set(productId, job);
      setState(job.status === "collecting" ? { kind: "polling", job } : { kind: "terminal", job });
      if (job.status === "collecting" && !busyRef.current) {
        busyRef.current = true; // dedupe a Collect-now click while the attach polls
        poll(job.jobId);
      }
    },
    [productId, poll],
  );

  return { state, cachedNoticeAt, start, retryRetailer, attach };
}
