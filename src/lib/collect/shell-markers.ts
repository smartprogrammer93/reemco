/**
 * REEA-1266 — the machine-readable marker a provisional results document
 * carries, and the ONE matcher both sides read.
 *
 * Why this exists: the /api/health funnel walk asserts on the served results
 * HTML. A provisional document is one whose served snapshot is NOT settled —
 * either a render deferred at the process-wide collection cap
 * (lib/collect/inflight.ts; the honest pending shell from
 * `renderBusySnapshot`) or a run whose completion budget closed while hops
 * were still in flight (`finalizedSnapshot`, `settled: false`). Both are
 * "still working", not "zero results": the follow-up feed folds the real
 * answer in behind the response. Without a marker the probe cannot tell that
 * state apart from a genuinely broken funnel that settled at zero cards, so
 * it answered 503 (cards=0) and the deploy gate / external monitor read it as
 * an outage (REEA-1262 AC-1 probe: 4 transient 503s under page fan-out load
 * while every shopper route answered 200).
 *
 * The renderer stamps the marker on the served shell
 * (components/ResultsClient.tsx, StageCoverage) and the probe detects it
 * through `hasCollectionPendingShell` — one constant pair so the attribute
 * name can never drift between the two sides. This module is
 * dependency-light on purpose: ResultsClient imports it, so it must stay
 * safe for the browser bundle.
 *
 * Absent marker = a settled document: the probe's normal assertions apply and
 * a settled zero remains a real 503.
 */
export const COLLECTION_PENDING_ATTR = "data-collection-pending";
export const COLLECTION_PENDING_VALUE = "1";

/** The exact attribute string the served shell carries (for docs/tests). */
export function collectionPendingMarker(): string {
  return `${COLLECTION_PENDING_ATTR}="${COLLECTION_PENDING_VALUE}"`;
}

/** True when this HTML is a provisional (not-yet-settled) results document. */
export function hasCollectionPendingShell(html: string): boolean {
  return html.includes(collectionPendingMarker());
}
