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
      } catch {
        /* transient network error — keep polling */
      }
      if (mountedRef.current) {
        pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    void tick();
  }, []);

  const start = useCallback(
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
