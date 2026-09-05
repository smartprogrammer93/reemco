/**
 * Client-facing collect-job module (REEA-84 W1).
 *
 * Client components (CollectionPulse et al.) must not import from
 * @/lib/collect/* — the store there is server-only (node:fs). This barrel
 * re-exports the shared job types and the real-progress derivation in a
 * client-safe module.
 */
export type {
  CollectJob,
  JobStatus,
  LiveOffer,
  RetailerSubtask,
  SubtaskStatus,
} from "@/lib/collect/types";
export { CACHE_TTL_MS, collectedAgoLabel, OVERALL_BUDGET_MS, PER_RETAILER_TIMEOUT_MS } from "@/lib/collect/types";
export { isJobSettled, jobProgress } from "@/lib/collect-progress";
