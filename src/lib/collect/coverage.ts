import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-437 — pure helpers shared by the LIVE collect chain (live-search.ts)
 * and the client-rendered results shell (ResultsClient.tsx). Everything here
 * must stay dependency-light: ResultsClient imports this module, so whatever
 * it pulls lands in the BROWSER bundle. live-search.ts keeps the server-only
 * machinery (node:zlib, the jsdom-backed clearance hop, the retailer
 * adapters) out of that graph; this file holds only the snapshot shape and
 * the plain-text coverage sentence. Behavior is unchanged from when both
 * lived in live-search.ts — the split is purely about graph weight.
 */

export interface LiveSearchResult {
  products: NormalizedProduct[];
  /** Per-retailer notes for the diagnostics panel; failures included. */
  notes: { merchant: string; hits: number; error?: string }[];
  /** Empty-match suggestion set (REEA-114); every snapshot carries its own. */
  suggestions?: NormalizedProduct[];
  /**
   * REEA-437 — the query forms the converged run actually issued (whole query
   * first, then the trimmed-token widening), present once the widened retry
   * ran. The empty state names them so a zero answer says what was tried
   * instead of just declaring the shelf empty.
   */
  attemptedQueries?: string[];
  /**
   * REEA-437 — false ONLY on finalized-at-budget snapshots: the completion
   * budget closed the stream while hops were still in flight, so a zero count
   * on such a snapshot is provisional (the late offers converge behind the
   * response and fold in through the follow-up feed). The heading renders its
   * skeleton for these instead of flashing "0 results" at the shopper.
   * Absent/undefined means the snapshot is the honest settled answer.
   */
  settled?: boolean;
}

/* Fixed presentation order for the coverage sentence — mirrors the COLLECTORS
   declaration order in live-search.ts (REEA-254 determinism: the same settled
   set reads as the same sentence on consecutive loads, whatever the completion
   order was). Kept as a plain name list so this module stays importable from
   the browser bundle; a parity test in live-search.test.ts pins it to the
   adapter list. Unknown merchants rank last, exactly like adapterRank did. */
export const COVERAGE_ORDER = [
  "Xcite",
  "Blink",
  "Eureka",
  "Sultan Center",
  "Jarir",
  "Amazon.eg",
  "Quadra Stores",
  "Next Store",
  "PC Kuwait",
  "Lulu Hypermarket",
  "Switch",
  "Wibi",
  "Astore",
  "Zayoom",
  "Yousifi",
  "Aster Pharmacy",
  "Nahdi",
  "Ounass",
  "Danube Home",
] as const;

function coverageRank(merchant: string): number {
  const i = COVERAGE_ORDER.indexOf(merchant as (typeof COVERAGE_ORDER)[number]);
  return i < 0 ? COVERAGE_ORDER.length : i;
}

/**
 * REEA-290 — the per-query coverage sentence the results page states in plain
 * text: which retailers answered this search and which did not, straight from
 * the run's own notes (no second fetch, no bundled registry — a note is only
 * ever written by the live fan-out that produced the offers on screen).
 * Names follow the fixed adapter order above. A retailer that answered with
 * zero matching hits DID respond — its empty shelf is an answer, not a gap —
 * so only notes carrying an error land on the "did not respond" side. An
 * empty notes list (nothing collected yet) yields an empty string: no line,
 * no flicker.
 */
export function coverageLine(
  notes: LiveSearchResult["notes"],
  locale?: "en" | "ar",
): string {
  const ordered = [...notes].sort(
    (a, b) => coverageRank(a.merchant) - coverageRank(b.merchant),
  );
  const failed: string[] = [];
  const answered: string[] = [];
  for (const n of ordered) {
    (n.error ? failed : answered).push(n.merchant);
  }
  // REEA-279: the two sentence shapes live in the static table so the stamp
  // matches the shell language; EN keeps the exact figures it had before.
  const ar = locale === "ar";
  const parts: string[] = [];
  if (failed.length > 0)
    parts.push(ar ? `${joinNames(failed, ar)} لم يستجب لهذا البحث.` : `${joinNames(failed)} did not respond on this search.`);
  if (answered.length > 0)
    parts.push(ar ? `أسعار من ${joinNames(answered, ar)}.` : `Prices from ${joinNames(answered)}.`);
  return parts.join(" ");
}

/** Plain-text name list: "Xcite" / "Xcite and Blink" / "Xcite, Blink and Eureka". */
function joinNames(names: string[], ar = false): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}${ar ? " و" : " and "}${names[names.length - 1]}`;
}
