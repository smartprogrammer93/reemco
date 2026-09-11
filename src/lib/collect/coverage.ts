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
  /** Per-retailer notes for the diagnostics panel; failures included.
   *  REEA-488 item 2: `coupons` counts that merchant's kept offers carrying
   *  coupon info among `hits` — coupon coverage per stage, so under-delivery
   *  by a specific adapter is measurable instead of guessed. */
  notes: { merchant: string; hits: number; coupons?: number; error?: string }[];
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
 * REEA-290 + REEA-574 rev 1 (R1) — the per-query coverage sentence the
 * results page states in plain text. The contributor half ('Prices from …' /
 * 'أسعار من …') names ONLY merchants with at least one RENDERED offer row at
 * final paint: callers pass the merchant names read from the rendered rows
 * array at paint time (country/stock toggles included), not adapter hit
 * counts — a retailer that answered successfully but left no row on screen
 * stays unnamed, so the sentence reads as what the shopper sees. An empty
 * rendered set hides the whole sentence: empty pages show heading + hint +
 * empty state only. Errored/timed-out adapters keep the unchanged
 * 'No response from …' half (an errored adapter shows no rows, so its name
 * never needs dedupe against the contributor half). Names keep the fixed
 * COVERAGE_ORDER presentation; the AR join stays byte-stable (half-width
 * commas, ' و' before the last name).
 */
export function coverageLine(
  renderedMerchants: readonly string[],
  errored?: readonly string[],
  locale?: "en" | "ar",
): string {
  const contributors = [...new Set(renderedMerchants)].sort(
    (a, b) => coverageRank(a) - coverageRank(b),
  );
  if (contributors.length === 0) return ""; // nothing rendered — no sentence
  const failed = [...new Set(errored ?? [])]
    .filter((m) => !contributors.includes(m))
    .sort((a, b) => coverageRank(a) - coverageRank(b));
  // REEA-279: the sentence shapes live in the static table so the stamp
  // matches the shell language; EN keeps the exact figures it had before.
  const ar = locale === "ar";
  const parts: string[] = [];
  if (failed.length > 0)
    // REEA-468 G3 (PM copy decision): short-form scans faster at the grid
    // slot — "No response from X" pairs with the coupon badge as its
    // counterpart, instead of the longer sentence.
    parts.push(ar ? `لا يوجد رد من ${joinNames(failed, ar)}.` : `No response from ${joinNames(failed)}.`);
  parts.push(ar ? `أسعار من ${joinNames(contributors, ar)}.` : `Prices from ${joinNames(contributors)}.`);
  return parts.join(" ");
}

/** Plain-text name list: "Xcite" / "Xcite and Blink" / "Xcite, Blink and Eureka". */
function joinNames(names: string[], ar = false): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}${ar ? " و" : " and "}${names[names.length - 1]}`;
}

/** REEA-488 item 2 — per-merchant coupon coverage rolled up over the notes
 *  of many snapshots (one weekly export). Merchants sum across snapshots in
 *  the fixed adapter order; `coverage` is couponOffers/offers, null when the
 *  merchant kept no offers at all in the window. */
export interface MerchantCouponCoverage {
  merchant: string;
  offers: number;
  couponOffers: number;
  coverage: number | null;
}

export function aggregateCouponCoverage(
  noteSets: Iterable<LiveSearchResult["notes"]>,
): MerchantCouponCoverage[] {
  const totals = new Map<string, { offers: number; couponOffers: number }>();
  for (const notes of noteSets) {
    for (const n of notes) {
      const t = totals.get(n.merchant) ?? { offers: 0, couponOffers: 0 };
      t.offers += n.hits;
      t.couponOffers += n.coupons ?? 0;
      totals.set(n.merchant, t);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => coverageRank(a[0]) - coverageRank(b[0]))
    .map(([merchant, t]) => ({
      merchant,
      offers: t.offers,
      couponOffers: t.couponOffers,
      coverage: t.offers > 0 ? t.couponOffers / t.offers : null,
    }));
}

/** REEA-488 metrics — alternatives fill rate over served products: one entry
 *  per snapshot's product list, counted as simple weekly numbers (AC: the
 *  non-empty rate on the top queries). */
export interface AlternativesFill {
  productsSeen: number;
  productsWithAlternatives: number;
  nonEmptyRate: number | null;
}

export function aggregateAlternativesFill(
  productSets: Iterable<NormalizedProduct[]>,
): AlternativesFill {
  let seen = 0;
  let filled = 0;
  for (const products of productSets) {
    for (const p of products) {
      seen += 1;
      if (p.alternatives.length > 0) filled += 1;
    }
  }
  return { productsSeen: seen, productsWithAlternatives: filled, nonEmptyRate: seen > 0 ? filled / seen : null };
}
