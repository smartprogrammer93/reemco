/**
 * REEA-1246 AC3 — the product page's lane rail is a RETAILER rail.
 *
 * The runner fans out one scrape per unique retailer+SKU listing (REEA-897),
 * so a retailer that lists the same SKU under several URLs legitimately owns
 * several subtasks. The rail rendered one chip per SUBTASK, so the same
 * retailer could appear twice ("Eureka, Eureka") and the "n/m stores" line
 * counted listings instead of stores — a progress claim that disagreed with
 * the retailer count the offer table prints.
 *
 * This fold is the ONE definition: one chip per distinct retailer, with the
 * aggregate state the shopper needs (any lane still running → collecting; a
 * retailer is done when at least one of its listings landed; it failed only
 * when every listing it owns failed). Pure and client-safe: no React, no I/O,
 * no clock.
 */
import type { RetailerSubtask } from "@/lib/collect/types";

export interface LaneChip {
  /** The retailer name exactly as the served subtasks spell it. */
  retailer: string;
  /** Aggregate arrival state for this retailer. */
  status: "pending" | "collecting" | "done" | "failed" | "timeout";
  /** Offers this retailer's lanes have landed so far (sum, never invented). */
  offersFound: number;
  /** First real error among this retailer's lanes, for the chip title. */
  error?: string;
  /** How many listings this retailer owns (one chip, N re-checks). */
  listings: number;
}

function retailerKey(retailer: string): string {
  return retailer.trim().toLowerCase();
}

/**
 * Fold served subtasks into one chip per retailer. Order is the first
 * appearance of each retailer, so the rail stays stable across polls.
 */
export function foldLaneChipsByRetailer(
  subtasks: readonly RetailerSubtask[],
): LaneChip[] {
  const byRetailer = new Map<string, LaneChip>();
  for (const subtask of subtasks) {
    const retailer = (subtask.retailer ?? "").trim();
    if (retailer === "") continue;
    const key = retailerKey(retailer);
    const existing = byRetailer.get(key);
    if (!existing) {
      byRetailer.set(key, {
        retailer,
        status: subtask.status,
        offersFound: subtask.offersFound ?? 0,
        ...(subtask.error ? { error: subtask.error } : {}),
        listings: 1,
      });
      continue;
    }
    existing.listings += 1;
    existing.offersFound += subtask.offersFound ?? 0;
    if (!existing.error && subtask.error) existing.error = subtask.error;
    // Aggregate state: a retailer with a landed listing is done even while
    // its other listings are still running; a retailer still in flight stays
    // collecting; it only reads failed when EVERY listing it owns failed.
    if (existing.status === "done" || subtask.status === "done") {
      existing.status = "done";
      continue;
    }
    if (existing.status === "collecting" || subtask.status === "collecting") {
      existing.status = "collecting";
      continue;
    }
    if (existing.status === "pending" || subtask.status === "pending") {
      existing.status = "pending";
      continue;
    }
    // Every lane is terminal without a done: keep the strongest failure label.
    if (existing.status === "failed" || subtask.status === "failed") {
      existing.status = "failed";
    }
  }
  return [...byRetailer.values()];
}
