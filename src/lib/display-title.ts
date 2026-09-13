/**
 * REEA-836 — display-side title hygiene for marketplace-sourced listing
 * titles. Retailer feeds chain seller boilerplate onto the product name
 * ("Apple iPhone 17 Pro 6.3-inch A3256 | Tax Paid But "eSIM Only" eSIM +
 * eSIM (8 or more, max 2 at a time) Unlocked, 512GB"), and the merged card's
 * canonical title can be exactly such a raw feed string. This module cleans
 * the string AT RENDER TIME only — pure function, no adapter change, no
 * stored data, no effect on ranking/matching inputs (company data policy:
 * the offer feed stays live-at-query-time; this is presentation).
 *
 * Contract:
 *  - deterministic and script-agnostic (EN + AR titles run the same rules);
 *  - a title with no detectable boilerplate comes back byte-identical
 *    (whitespace collapse does not count as a change — AC6);
 *  - brand + model + storage are never lost (AC2): when a dropped
 *    boilerplate clause was carrying the only storage token, the token is
 *    re-attached to the cleaned head;
 *  - the caller renders the ORIGINAL string beside the cleaned one (tooltip /
 *    disclosure in ProductResultCard) — transparency, not data loss (AC3).
 */

/** Phrases that mark a clause as seller promo/boilerplate rather than
 *  product identity. Evidence-driven, kept deliberately small: the strings
 *  observed in live probes (REEA-830 brief) plus the warranty/gift class the
 *  matching layer already treats as marketing restatement. Arabic markers
 *  cover the same classes (warranty / tax / gift / free) so AR titles get the
 *  identical cleanup. */
const PROMO_PHRASE_RES: RegExp[] = [
  /tax[\s-]*paid/gi,
  /\bwith\s+face\s+id\b/gi,
  /\be-?sim\s+only\b/gi,
  /\bfactory[\s-]*unlocked\b/gi,
  /\bunlocked\b/gi,
  /\bwarrant(?:y|ies)\b/gi,
  // Arabic markers: JS \b is Latin-word-boundary only ([A-Za-z0-9_]), so the
  // Arabic class needs explicit Unicode-letter lookarounds to match at all.
  /(?<![\p{L}\p{N}\p{M}])ضمان(?![\p{L}\p{N}\p{M}])/gu,
  /(?<![\p{L}\p{N}\p{M}])ضريبة(?![\p{L}\p{N}\p{M}])/gu,
  /(?<![\p{L}\p{N}\p{M}])هدية(?![\p{L}\p{N}\p{M}])/gu,
  /(?<![\p{L}\p{N}\p{M}])مجاناً?(?![\p{L}\p{N}\p{M}])/gu,
  /(?<![\p{L}\p{N}\p{M}])شحن\s+مجاني(?![\p{L}\p{N}\p{M}])/gu,
];

/** A clause is boilerplate when it reads as a quantity/ promo rule rather
 *  than a product attribute ("(8 or more, max 2 at a time)", "Tax Paid …"). */
const PROMO_CLAUSE_RE =
  /(?:tax[\s-]*paid|with\s+face\s+id|e-?sim\s+only|\bunlocked\b|warrant(?:y|ies)|\b\d+\s+or\s+more\b|\bat\s+a\s+time\b|\bmax(?:imum)?\s*\d+\b|ضمان|ضريبة|هدية|مجانا)/i;

const STORAGE_TOKEN_CAPTURE_RE = /\b(\d+(?:\.\d+)?)\s?(gb|tb)\b/gi;
const STORAGE_DETECT_RE = /\b\d+(?:\.\d+)?\s?(?:gb|tb)\b/i;
/** Promo parenthetical groups ("(8 or more, max 2 at a time)") drop whole —
 *  unless they carry a capacity ("(256 GB)" is an attribute, never chrome). */
const PAREN_GROUP_RE = /\(([^()]*)\)/g;
/** Dangling connector words left behind after a phrase scrub, trimmed from
 *  the string edges only ("… Unlocked, 512GB" → "… 512GB", "But eSIM" edges). */
const EDGE_FILLER_RE =
  /^(?:[,;:.\-–—|+\s]|but\b|only\b|and\b|with\b|و(?![\p{L}]))+|(?:[,;:.\-–—|+\s])+$/giu;

function scrubClauses(segment: string): string {
  let t = segment;
  // Promo parentheticals drop with their contents; a group that carries a
  // capacity ("(256 GB)") is an attribute restatement and stays.
  t = t.replace(PAREN_GROUP_RE, (group, inner: string) =>
    PROMO_CLAUSE_RE.test(inner) && !STORAGE_DETECT_RE.test(inner) ? " " : group,
  );
  for (const re of PROMO_PHRASE_RES) t = t.replace(re, " ");
  return t
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:])/g, "$1")
    .replace(EDGE_FILLER_RE, "")
    .trim();
}

/**
 * Clean one retailer listing title for display. Pipes are treated as clause
 * separators: the head clause is always kept (it names the product), each
 * tail clause survives only when it is not boilerplate, and storage tokens
 * stranded inside dropped clauses are re-attached so the cleaned title keeps
 * brand + model + storage (REEA-836 AC1/AC2). Pure: same input, same output.
 */
export function cleanDisplayTitle(raw: string): string {
  const input = raw.trim();
  if (input === "") return raw;
  const segments = input.split("|");
  if (segments.length === 1 && !PROMO_CLAUSE_RE.test(input) && !PAREN_GROUP_RE.test(input)) {
    // AC6 fast path: nothing detectable to clean — the title renders as-is.
    return raw;
  }
  const head = scrubClauses(segments[0]);
  const kept: string[] = [];
  if (head !== "") kept.push(head);
  const recoveredStorage: string[] = [];
  for (const segment of segments.slice(1)) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    if (PROMO_CLAUSE_RE.test(trimmed)) {
      // Boilerplate clause: dropped — but harvest the storage tier it was
      // carrying ("… Unlocked, 512GB") so no product attribute is lost.
      for (const m of trimmed.matchAll(STORAGE_TOKEN_CAPTURE_RE)) {
        recoveredStorage.push(`${m[1]}${m[2].toUpperCase()}`);
      }
      continue;
    }
    const scrubbed = scrubClauses(trimmed);
    if (scrubbed !== "") kept.push(scrubbed);
  }
  let title = kept.join(" ").replace(/\s+/g, " ").trim();
  if (
    recoveredStorage.length > 0 &&
    !STORAGE_DETECT_RE.test(title)
  ) {
    title = `${title} ${recoveredStorage[0]}`.trim();
  }
  return title === "" ? raw : title;
}

/**
 * Whether the cleanup actually rewrote this title beyond whitespace
 * normalization — drives the "original title" affordance (REEA-836 AC3):
 * pure-whitespace differences never count, so a clean title renders with no
 * disclosure at all (AC6).
 */
export function displayTitleChanged(raw: string, cleaned: string): boolean {
  return cleaned !== raw.trim().replace(/\s+/g, " ");
}
