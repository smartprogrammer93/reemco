/**
 * REEA-1224 — read the deployed results page's RSC "notes" arrays.
 *
 * Why this module exists: scripts/smoke-check.mjs step 7 asserted adapter
 * dispatch parity by regexing `notes\":[...]` out of the served HTML with
 * `[^\]]*`. That is wrong whenever a note's `error` string contains a literal
 * `]` — which is exactly what the Next Store browser-tier failure now carries
 * (`... --disable-background-n]`). The match stopped inside that error, so the
 * "longest" array looked like a 12-note intermediate flush and the gate
 * reported Sultan Center / Lulu Hypermarket / Aster Pharmacy as missing even
 * though the final snapshot's `responders.queried` named all 23 lanes.
 *
 * This parser walks the flight payload bracket-by-bracket and treats `]`
 * inside an escaped string as data, not as the array terminator. Pure, no I/O;
 * the smoke imports it and src/lib/metrics/flight-notes.test.ts pins it.
 */

const NOTES_MARKER = 'notes\\":[';
const MERCHANT_RE = /merchant\\":\\"([^\\]+)/g;

/**
 * Extract the raw text of every `notes` array in the RSC payload, in flush
 * order. The payload escapes quotes as `\"`, so string state is tracked on
 * that pair; escaped backslashes (`\\`) and `\uXXXX` sequences are skipped so
 * they cannot be mistaken for a quote or a bracket.
 */
export function extractNotesArrays(html) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf(NOTES_MARKER, from);
    if (at < 0) break;
    let i = at + NOTES_MARKER.length;
    let depth = 1;
    let inString = false;
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (inString) {
        if (c === "\\") {
          const next = html[i + 1];
          if (next === '"') {
            inString = false;
            i += 2;
            continue;
          }
          // Escaped backslash, \n, \uXXXX, ... — neither a quote nor a bracket.
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (c === "\\" && html[i + 1] === '"') {
        inString = true;
        i += 2;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]") depth--;
      i++;
    }
    if (depth !== 0) break; // unterminated array: leave what we have
    out.push(html.slice(at + NOTES_MARKER.length, i - 1));
    from = i;
  }
  return out;
}

/** Merchant names named by one notes array (arrival order). */
export function notesMerchants(arrayText) {
  return [...arrayText.matchAll(MERCHANT_RE)].map((m) => m[1]);
}

/**
 * The final snapshot's notes array: the longest one in flush order (the run
 * only ever appends lanes, so the last complete array is the final state).
 * Returns null when the payload carries no notes array at all.
 */
export function longestNotesArray(html) {
  const arrays = extractNotesArrays(html);
  if (arrays.length === 0) return null;
  return arrays.reduce((a, b) => (b.length > a.length ? b : a));
}
