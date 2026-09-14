/**
 * REEA-964 R2 — the relevance confidence ladder behind the two-section
 * results hierarchy and the honest empty state (spec
 * REEA-961 §4/§5 FR-1/FR-2). Pure and deterministic; consumes the existing
 * REEA-213 relevance tiers instead of inventing a second matcher, so there
 * is exactly ONE matching mechanism in the codebase and the R2 confidence
 * decision rides it.
 *
 *  - CONFIDENT (score >= CONFIDENCE_THRESHOLD): the offer answers the query
 *    itself. Primary results section.
 *  - Below threshold but > 0 (shares real token coverage / accessory affinity
 *    with the query): related accessories band only — capped, labeled, never
 *    a peer card in primary.
 *  - 0: no affinity at all. Rendered nowhere — a nonsense query renders the
 *    honest empty state, not loosely-related products dressed as results.
 *
 * The threshold is ONE configuration value (spec: "the threshold is one
 * configuration value"); calibration only ever touches this constant.
 */

import {
  isAccessoryTitle,
  normalizeArabicText,
  normalizedTitle,
  relevanceTier,
  skuCodeTokens,
  tierQueryTokens,
  titleCarriesCode,
} from "@/lib/relevance";

/**
 * REEA-964 — the single confidence threshold. A match is confident iff
 * matchConfidence() >= this value. Calibration contract (spec AC-1/AC-2):
 * the value must keep `iPhone 17 Pro` phones confident while KD 0.46 cases
 * fall to the related band, and leave `zzqqxx nonexistent gadget` with zero
 * confident matches (honest empty state).
 *
 * Score ladder (see matchConfidence): 2 = full query-token coverage in the
 * title (REEA-213 tiers 1–2); 1 = partial/metadata-only coverage (tier 3–4)
 * or an accessory-marked title under a non-accessory query; 0 = no match.
 * Threshold 2 therefore means: confident == the title answers the WHOLE
 * query. 1 would let half-matched rows into primary (relevance dilution
 * back); 3 is unreachable (max score is 2).
 */
export const CONFIDENCE_THRESHOLD = 2;

/** FR-2.2 — the related band is capped at 6 items. */
export const RELATED_CAP = 6;

/** Accessory-marker substring check on the normalized query: when the shopper
 *  is ASKING for the accessory ("iphone 17 pro case"), accessory titles are
 *  the product — no demotion. Reuses the REEA-180 accessory marker list on
 *  the query side so one classification governs both sides. */
export function isAccessoryQuery(query: string): boolean {
  return isAccessoryTitle(query);
}

/**
 * Confidence score for one offer title against the query:
 *  2 — the title carries the WHOLE query identity: every query token matched
 *      whole-word at tiers 1–2, or the exact-SKU code shape, or the
 *      substring bridge (below). → primary.
 *  1 — metadata-only match (tier 4: the title itself never named the query),
 *      or full token coverage on an ACCESSORY-marked title while the query is
 *      not itself accessory-shaped (the "iPhone 17 Pro" query vs
 *      "iPhone 17 Pro Case" row: the case answers the query's tokens but it
 *      is the companion product, never a peer of the device). → the related
 *      band only.
 *  0 — no affinity (tier 0 with no substring bridge) → rendered nowhere.
 *
 * Substring bridge: short model qualifiers ("xm6" inside "WH-1000XM6",
 * "s25" inside "SM-S25…") never fire the whole-word REEA-213 ladder — the
 * qualifier is buried inside one longer title word — yet the title plainly
 * carries the queried identity, and the pre-R2 page rendered exactly these
 * rows (search.ts haystack floor). When EVERY query token appears in the
 * folded title text, the row keeps confident standing (accessory demotion
 * still applies); partial bridge coverage changes nothing.
 *
 * Exact-SKU queries (REEA-721 code shape) keep full confidence for the
 * code-carrying row regardless of accessory markers — the REEA-822 contract
 * (an exact part-number query is about THAT listing, even when the title
 * says "Case") outranks the accessory demotion. Checked FIRST: a hyphenated
 * storefront code is ONE title word, so the per-token ladder scores it 0.
 */
export function matchConfidence(query: string, title: string, metadata = ""): number {
  const codes = skuCodeTokens(query);
  if (codes.length > 0 && titleCarriesCode(title, codes)) return CONFIDENCE_THRESHOLD;
  const tokens = tierQueryTokens(query);
  const foldedTitle = normalizeArabicText(normalizedTitle(title)).toLowerCase();
  const fullCoverage =
    tokens.length === 0 || tokens.every((t) => foldedTitle.includes(t));
  if (!fullCoverage) {
    const tier = relevanceTier(query, title, metadata);
    if (tier === 0) return 0;
    // Tier 3 = at least half the tokens matched whole-word: the shape of a
    // real query with descriptor words the title spells differently
    // ("...512gb blue titanium" vs a Silver listing) — the product IS the
    // answer, it stays primary. Tier 4 = matched only via merchant metadata
    // (the title itself never named the query) — related-band material.
    if (tier === 4) return 1;
  }
  if (isAccessoryTitle(title) && !isAccessoryQuery(query)) return 1;
  return CONFIDENCE_THRESHOLD;
}

/**
 * Split a ranked candidate list into the two R2 sections:
 *  - primary: confidence >= CONFIDENCE_THRESHOLD, incoming rank order kept;
 *  - related: below threshold, above zero, capped at RELATED_CAP.
 * Tier-0 rows (no shared token with the query) are dropped entirely — a
 * nonsense query renders the empty state, never loosely-related filler.
 */
export function partitionByConfidence<T extends { title: string }>(
  query: string,
  products: readonly T[],
): { primary: T[]; related: T[] } {
  const primary: T[] = [];
  const related: T[] = [];
  for (const p of products) {
    const score = matchConfidence(query, p.title);
    if (score >= CONFIDENCE_THRESHOLD) primary.push(p);
    else if (score > 0 && related.length < RELATED_CAP) related.push(p);
  }
  return { primary, related };
}
