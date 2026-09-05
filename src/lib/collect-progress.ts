import type { CollectJob } from "@/lib/collect/types";

/**
 * Real progress derivation from W1 collection-job states (REEA-84 plan AC2,
 * REEA-90 C8). The Pulse UI renders ONLY these real per-retailer subtask
 * states — no synthetic/timed progress is ever presented as progress.
 */

/** True when every subtask has reached a terminal per-retailer state. */
export function isJobSettled(job: CollectJob): boolean {
  return (
    job.status !== "collecting" ||
    (job.subtasks.length > 0 &&
      job.subtasks.every(
        (s) => s.status === "done" || s.status === "failed" || s.status === "timeout",
      ))
  );
}

/**
 * Progress fraction from subtask states only: done counts; failed/timeout
 * count as resolved (they no longer move the bar).
 */
export function jobProgress(job: CollectJob): number {
  if (job.subtasks.length === 0) return 0;
  const resolved = job.subtasks.filter(
    (s) => s.status === "done" || s.status === "failed" || s.status === "timeout",
  ).length;
  return resolved / job.subtasks.length;
}
