"use client";

/**
 * REEA-84 W1 T4 — client collection hook.
 *
 * Flow: start(productId) -> POST /api/products/:id/collect -> poll
 * GET /api/collect-jobs/:jobId every 1.5 s until terminal -> expose the job
 * snapshot for rendering. Double-clicks are deduped: a start while a start or
 * poll cycle is active is a no-op (AC8), matching the server-side in-flight
 * dedupe. retryRetailer re-runs one failed retailer (T6) and resumes polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectJob } from "@/lib/collect/types";

const POLL_INTERVAL_MS = 1500;

export type CollectionPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "polling"; job: CollectJob }
  | { kind: "terminal"; job: CollectJob };

export function useCollection(productId: string) {
  const [state, setState] = useState<CollectionPhase>({ kind: "idle" });
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
          setState({ kind: "terminal", job });
          busyRef.current = false;
          return;
        }
        if (res.status === 404) {
          // Serverless warm-instance miss: the polling instance cannot see the
          // job created elsewhere. Re-start the collection once — the freshness
          // rule and dedupe still bound the work (REEA-88 cross-instance note).
          if (restartsRef.current < 1 && mountedRef.current) {
            restartsRef.current += 1;
            busyRef.current = false;
            void startRef.current?.();
            return;
          }
          // Restart budget exhausted — the poll function cannot see the job
          // created by the collect function (on Vercel each API route is a
          // separate serverless function: no shared memory or /tmp). Fall back
          // to the synchronous ?wait=1 mode, which runs the collection inside
          // the POST invocation and returns the terminal snapshot with real
          // per-retailer subtask states (AC2) — bounded by the 25s budget.
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
                  setState({ kind: "terminal", job });
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
      if (busyRef.current) return; // AC8: dedupe double-clicks client-side too
      busyRef.current = true;
      setState({ kind: "starting" });
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

  return { state, start, retryRetailer };
}
