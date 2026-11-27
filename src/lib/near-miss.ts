/**
 * REEA-1270 (Bet 3) — bounded, deterministic near-miss correction for
 * misspelled Latin brand/model tokens on the live dispatch path.
 *
 * The defect this module answers: a shopper types `iphon 17 pro` and the site
 * says the product does not exist. The retailers' own indexes do not fuzzy
 * match the typo (`iphon 17 pro` measured 4/4 zero-offer serves while
 * `iphone 17 pro` answered 443/443), and the page offered no correction. The
 * query normalization layer therefore needs to name the corrected spelling and
 * dispatch it.
 *
 * Design constraints from the ticket, all deliberate:
 *  - STATIC and deterministic: the canonical vocabulary is a curated, shipped
 *    word list built from the existing curated sources (the AR↔EN lexicon's
 *    Latin forms and the curated brand list) plus a small explicit tail. No
 *    ML service, no per-query or per-user storage (R-6), no request-time
 *    catalogue scan.
 *  - BOUNDED edit distance: exactly one Damerau-Levenshtein edit (insert,
 *    delete, substitute, or a single adjacent transposition — `reciever` →
 *    `receiver` is a transposition). Only Latin alphabetic tokens of 5–24
 *    characters are eligible, at most two per query.
 *  - CONSERVATIVE: a token that is itself a canonical spelling is never
 *    touched, the candidate must share the typo's first letter, and the
 *    correction must be a single edit. That keeps real words (`note`, `air`,
 *    `pads`, `pro`) out of the correction path — the measured
 *    over-correction risk the scope boundary names.
 *  - Arabic is NOT re-expanded here: Arabic token bridging stays Bet 8's
 *    (`lib/arabic-lexicon.ts`). Arabic-script tokens simply ride through.
 *
 * The caller (the live dispatch) applies this only on a zero-offer answer,
 * riding the ONE bounded widened-retry slot REEA-437 already owns, so no
 * second cold fan-out is added (R-4) and a query that already answers is
 * never re-spelled (no regression on a working shelf, R-5).
 */
import { ARABIC_BRAND_ALIASES, ARABIC_MODEL_ALIASES, ARABIC_QUERY_ALIASES } from "@/lib/arabic-lexicon";
import { CURATED_BRANDS } from "@/lib/relevance";

/** Shortest eligible token: below this, one edit is too coarse (`pads` →
 *  `pad`, `air` → `aim`). The measured typo panel is all ≥5 characters. */
const MIN_TOKEN_LENGTH = 5;

/** Longest eligible token. Anything longer is a pasted part number, not a
 *  brand/model word; the code path (`skuCodeTokens`) owns those. */
const MAX_TOKEN_LENGTH = 24;

/** Bounded correction budget per query. */
export const MAX_CORRECTIONS_PER_QUERY = 2;

/**
 * Extra curated brand/model tokens the retailers carry that the AR↔EN
 * lexicon does not already list. Small and hand-curated on purpose — every
 * entry here widens the one-edit correction surface, so it only holds words
 * the panel/benchmark measured as demand targets (Whirlpool, Dyson Airwrap,
 * the audio `receiver` class, Kindle) plus the current phone/laptop brands
 * the four Kuwait retailers stock. Nothing is generated from product titles.
 */
const EXTRA_LATIN_TOKENS: readonly string[] = [
  "whirlpool",
  "airwrap",
  "receiver",
  "airpods",
  "kindle",
  "paperwhite",
  "macbook",
  "redmi",
  "poco",
  "oneplus",
  "motorola",
  "nokia",
  "infinix",
  "tecno",
  "tablet",
  "speaker",
  "soundbar",
  "earbuds",
  "airfryer",
  "blender",
  "toaster",
  "dishwasher",
  "refrigerator",
];

const LATIN_TOKEN_RE = /^[a-z]+$/i;
const ARABIC_RE = /[\u0600-\u06FF]/;

/** Split a curated form ("washing machine", "Head & Shoulders") into its
 *  Latin word tokens. Only whole words ≥ MIN_TOKEN_LENGTH enter the set, so
 *  the candidate scan stays small and no filler word is ever a target. */
function addWords(set: Set<string>, form: string): void {
  for (const word of form.toLowerCase().split(/[^a-z]+/)) {
    if (word.length >= MIN_TOKEN_LENGTH && word.length <= MAX_TOKEN_LENGTH) set.add(word);
  }
}

function buildCanonicalVocabulary(): ReadonlySet<string> {
  const set = new Set<string>();
  for (const brand of CURATED_BRANDS) addWords(set, brand);
  for (const forms of ARABIC_QUERY_ALIASES.values()) for (const form of forms) addWords(set, form);
  for (const latin of ARABIC_MODEL_ALIASES.values()) addWords(set, latin);
  for (const brand of ARABIC_BRAND_ALIASES.values()) addWords(set, brand);
  for (const token of EXTRA_LATIN_TOKENS) addWords(set, token);
  return set;
}

/**
 * The canonical Latin vocabulary this module corrects toward. Exported for
 * the tests and the bounded-scan assertions; treat it as read-only.
 */
export const CANONICAL_LATIN_TOKENS: ReadonlySet<string> = buildCanonicalVocabulary();

/** Canonical tokens grouped by their first letter, so a typo only ever scans
 *  candidates that could share its first letter (bounded and deterministic). */
const BY_INITIAL: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const token of CANONICAL_LATIN_TOKENS) {
    const key = token[0];
    const bucket = map.get(key) ?? [];
    bucket.push(token);
    map.set(key, bucket);
  }
  for (const bucket of map.values()) bucket.sort();
  return map;
})();

/**
 * Optimal-string-alignment (Damerau-Levenshtein with adjacent transposition)
 * distance, capped at 2. Only the exact value 1 is ever used, so the cap lets
 * the scan stop early instead of measuring long unrelated words.
 */
export function boundedEditDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      // Adjacent transposition ("reciever" → "receiver").
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2][j - 2] + 1);
      }
      d[i][j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

/**
 * The one canonical spelling a single token is a near miss of, or null.
 *
 * Guards, in order: Latin letters only, the bounded length window, the token
 * is not already canonical, and the candidate shares the first letter and is
 * exactly one edit away. Ties break deterministically (same length first —
 * a substitution/transposition is a nearer shape than an insert/delete —
 * then lexicographic), so the same typo always resolves to the same word.
 */
export function correctToken(token: string): string | null {
  if (!LATIN_TOKEN_RE.test(token)) return null;
  const lower = token.toLowerCase();
  if (lower.length < MIN_TOKEN_LENGTH || lower.length > MAX_TOKEN_LENGTH) return null;
  if (CANONICAL_LATIN_TOKENS.has(lower)) return null;
  const candidates = BY_INITIAL.get(lower[0]);
  if (!candidates) return null;
  const hits: string[] = [];
  for (const candidate of candidates) {
    if (boundedEditDistance(lower, candidate) !== 1) continue;
    hits.push(candidate);
  }
  if (hits.length === 0) return null;
  hits.sort(
    (a, b) =>
      Math.abs(a.length - lower.length) - Math.abs(b.length - lower.length) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  return hits[0];
}

export interface NearMissCorrection {
  /** The shopper's original query, trimmed. */
  from: string;
  /** The corrected dispatch spelling (only the typo tokens are re-spelled;
   *  every other token rides through verbatim). */
  to: string;
  /** Per-token detail for the page/probe: the typo and its correction. */
  tokens: { from: string; to: string }[];
}

/**
 * Correct a purely-Latin shopper query's misspelled brand/model tokens.
 * Returns null when nothing is a bounded one-edit near miss — the caller then
 * keeps the shipped spelling exactly.
 *
 * Arabic-script tokens are never re-spelled (Bet 8 owns that path) and tokens
 * carrying digits are model codes (`wh1000xm6`, `s25`, `520bt`), which the
 * code path matches by shape, so both ride through untouched.
 */
export function nearMissCorrection(query: string): NearMissCorrection | null {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  const rawTokens = trimmed.split(/\s+/).filter(Boolean);
  const tokens: { from: string; to: string }[] = [];
  const out: string[] = [];
  for (const raw of rawTokens) {
    // Punctuation around a token is not part of the word; keep it on the
    // token so the dispatch spelling stays the shopper's own.
    const word = raw.replace(/^[^A-Za-z0-9\u0600-\u06FF]+|[^A-Za-z0-9\u0600-\u06FF]+$/g, "");
    if (
      tokens.length < MAX_CORRECTIONS_PER_QUERY &&
      word !== "" &&
      !ARABIC_RE.test(word) &&
      !/\d/.test(word)
    ) {
      const corrected = correctToken(word);
      if (corrected) {
        tokens.push({ from: word, to: corrected });
        out.push(raw.replace(word, corrected));
        continue;
      }
    }
    out.push(raw);
  }
  if (tokens.length === 0) return null;
  return { from: trimmed, to: out.join(" "), tokens };
}
