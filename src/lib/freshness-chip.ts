/**
 * REEA-1092 — the freshness-chip matcher shared by the blocking deploy gate.
 *
 * The funnel probe (/api/health) and step 4 of scripts/smoke-check.mjs assert
 * that a live results page renders an honest last-verified chip. REEA-1069
 * AC10 changed the chip copy: a sub-minute age now reads "Updated just now"
 * (AR "حُدِّث الآن") and one minute reads "Updated 1 minute ago". Because a
 * live query stamps offers at 0 minutes, the old "N minutes ago" matcher
 * matched nothing, so /api/health answered 503 on the Shelf build and the
 * deploy rolled back (run 45125867791: "results has 10 cards but no
 * freshness chip"). The probe is the gate, not the UI — the copy is correct,
 * so the matcher accepts both the new and the legacy spellings.
 *
 * scripts/smoke-check.mjs carries the same literal (it is plain JS and cannot
 * import this module); src/lib/freshness-chip.test.ts pins the two together.
 */
export const FRESH_CHIP_RE =
  "(?:Verified|updated)[ ]*(?:<!--[ ]-->)?[ ]*(?:just now|\\d+[ ]*minutes? ago|\\d+[hd] ago|minutes? ago)";

export const FRESH_CHIP_ALT_RE =
  "may be outdated|(?:updated|Verification) date unknown";
