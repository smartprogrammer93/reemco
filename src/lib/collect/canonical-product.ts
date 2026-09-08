/**
 * REEA-168 — deterministic canonical product key per the REEA-167 spec §1.
 *
 * The key is an ordered tuple brand | model_line | storage | color |
 * condition_grade, computed AT QUERY TIME from the live retailer titles the
 * adapters return — no bundled catalog, no shipped alias table (company data
 * policy). Vocabularies below are matching rules (which token plays which
 * role), not product data: every field value comes from the fetched title.
 *
 * Rules implemented, in spec order:
 *  1. lowercase / trim / collapse whitespace; commas, hyphens, en/em-dashes
 *     and quote marks between attribute tokens act as spaces
 *     ("256 GB" ≡ "256GB" ≡ "256-gb"; `6.9"` ≡ "6.9 inch");
 *  2. brand = first known-brand token (fallback: first token); model_line =
 *     contiguous model-line tokens after the brand — size suffixes that define
 *     the line are kept; storage = first `<digits> gb|tb` NOT qualified as
 *     RAM; color = color-vocabulary match, multi-word official names collapse
 *     to the base color; condition_grade from the grade vocabulary plus an
 *     optional grade letter ("Renewed Grade B" → renewed-grade-b), absent →
 *     `new` — grade letters are significant;
 *  3. RAM/CPU/display restatements, device-type nouns, connectivity suffixes
 *     and marketing suffixes are ignored;
 *  4. fields join with `|`; partial-match equality lives in compatibleFields:
 *     every field that is non-empty on BOTH sides must be equal, so a subset
 *     key (missing color/storage) joins the matching full group instead of
 *     splitting it, while different storage/color/grade/model-line never do.
 */

export interface CanonicalFields {
  brand: string;
  modelLine: string;
  storage: string;
  color: string;
  /** Always present: absent grade means `new` (spec §1 step 2). */
  grade: string;
}

/* Matching vocabularies — roles for tokens, not catalog rows. */

const BRANDS = new Set([
  "samsung", "apple", "xiaomi", "huawei", "google", "oppo", "vivo", "honor",
  "oneplus", "nothing", "sony", "bose", "lg", "asus", "lenovo", "dell", "hp",
  "microsoft", "keychron", "anker", "jbl", "beats", "nokia", "motorola",
  "realme", "tecno", "infinix", "philips", "hisense", "tcl", "sharp",
]);

/** Spec §1 color vocabulary — exact words, casing/space noise already gone. */
const COLORS = new Set([
  "silver", "black", "white", "blue", "green", "gray", "grey", "gold", "red",
  "violet", "beige",
]);

/** Modifier words that open a two-word official colour name (§1 step 2):
 *  "cobalt violet" → violet, "titanium black" → black. The base colour itself
 *  is matched through COLORS; a known base followed by a modifier ("silver
 *  shadow") needs no prefix entry — the scan closes the colour on "silver" and
 *  ignores the trailing word after the stop. */
const COLOR_PREFIXES = new Set([
  "cobalt", "titanium", "phantom", "cosmic", "midnight", "starlight", "jet",
  "sky", "ice", "desert", "mist", "frost", "lava", "solar", "aurora",
]);

const GRADE_WORDS = new Set(["new", "renewed", "refurbished", "opened"]);
const GRADE_LETTERS = new Set(["a", "b", "c", "d"]);

/** Ignored tokens (§1 step 3): device-type nouns, connectivity suffixes,
 *  spec restatements, marketing tails. Accessory nouns (case / cover /
 *  charger …) deliberately STAY in the model line — they identify a
 *  different product for the same device, so a case must not fold into the
 *  phone's own offer list (REEA-169 finding 1). */
const NOISE = new Set([
  "phone", "smartphone", "mobile", "tablet", "laptop", "notebook", "monitor",
  "keyboard", "mouse", "headphones", "headphone", "headset", "earbuds",
  "speaker", "tv",
  "5g", "4g", "3g", "lte", "gprs", "wifi", "wi", "fi", "esim", "sim",
  "snapdragon", "elite", "exynos", "dimensity", "helios", "octa", "core",
  "with", "pen", "global", "version", "unlocked", "ram", "memory", "mem",
  "inch", "inches",
]);

const STORAGE_RE = /^(\d+(?:\.\d+)?)(gb|tb)$/;
/** "12gbram" (merged in the join pass) is RAM restated, never storage. */
const RAM_QUANTITY_RE = /^\d+(?:g|gb|t|tb)ram$/i;

/** Arabic storage units, joined onto the quantity in the join pass so an
 *  Arabic-script capacity keeps the same normalized value as the Latin one
 *  (REEA-205: "256 جيجابايت" ≡ "256GB", so 256 vs 512 still discriminates). */
const AR_UNITS = new Map([
  ["جيجابايت", "gb"], ["جيجا", "gb"], ["جب", "gb"],
  ["تيرابايت", "tb"], ["تيرا", "tb"],
]);

/** RAM/memory restatements in either script — same role as the NOISE words. */
const RAM_WORDS = new Set(["ram", "memory", "mem", "رام", "ذاكرة"]);

/**
 * Normalise + tokenize: casing/whitespace collapsed, commas/hyphens/dashes
 * and quote marks become spaces, then a small join pass reassembles split
 * attribute tokens ("256 gb" → "256gb", "fold 7" → "fold7", "grade b" stays
 * adjacent).
 */
export function canonicalTokens(title: string): string[] {
  const raw = title
    .toLowerCase()
    .replace(/open[\s-]+box/g, "open-box")
    .replace(/[,;:\-/‒–—]/g, " ")
    // REEA-205: quote-family marks fold to separators too — the inch sign
    // arrives as `"`/″/” depending on the retailer's feed encoding, and a
    // trailing quote after a size figure must tokenize exactly like the
    // spelled form (`6.9"` ≡ `6.9 inch`), not ride inside the number token.
    .replace(/["“″”"'‘]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = raw.split(" ").filter(Boolean);

  const out: string[] = [];
  /** True when the token at j is a storage/RAM qualifier — a quantity that
   *  carries its own unit must be joined by the number pass, not swallowed
   *  by the preceding word ("ماكس 256 جيجابايت" keeps storage visible). */
  const qualifierAt = (j: number): boolean => {
    const w = base[j];
    return w === "gb" || w === "tb" || (w !== undefined && (AR_UNITS.has(w) || RAM_WORDS.has(w)));
  };
  for (let i = 0; i < base.length; i++) {
    let t = base[i];
    const next = (): string | undefined => base[i + 1];
    // numeric + unit → single token; "ram"-qualified quantities stay marked.
    if (/^\d+(?:\.\d+)?$/.test(t)) {
      const n = next();
      const unit = n === "gb" || n === "tb" ? n : AR_UNITS.get(n ?? "");
      if (unit) {
        const third = base[i + 2];
        const rammed = third !== undefined && RAM_WORDS.has(third);
        t = `${t}${unit}${rammed ? "ram" : ""}`;
        i += rammed ? 2 : 1;
      } else if (n !== undefined && RAM_WORDS.has(n)) {
        t = `${t}gbram`;
        i += 1;
      } else {
        // A bare number before a word ("fold 7") extends the word instead —
        // merge at the word side; standalone numbers are skipped later.
        out.push(t);
        continue;
      }
    }
    // word + number merge for model codes written apart ("fold 7" → "fold7"),
    // unless the word itself is ignored noise ("snapdragon 8" is dropped) or
    // the number carries its own unit/RAM qualifier right after it.
    // REEA-205: any-script word — Arabic model lines keep their generation
    // number too ("آيفون 17" → "آيفون17"), matching what Latin titles get.
    if (
      /^[\p{L}]+$/u.test(t) &&
      !NOISE.has(t) &&
      !COLORS.has(t) &&
      /^\d{1,4}$/.test(base[i + 1] ?? "") &&
      !qualifierAt(i + 2)
    ) {
      const joined = base[i + 1];
      t = `${t}${joined}`;
      i += 1;
    }
    // Two-word official colour names collapse to the base colour: an unknown
    // modifier before a known colour ("cobalt violet" → violet) becomes that
    // colour; before another unknown word the pair keeps its first token
    // verbatim (§1: unknown colour token kept as one token). Known-base-first
    // names ("silver shadow") need no pass here — the scan closes the colour
    // on the known word and ignores what follows the stop.
    if (!COLORS.has(t) && COLOR_PREFIXES.has(t) && /^[a-z]+$/.test(base[i + 1] ?? "")) {
      if (COLORS.has(base[i + 1])) t = base[i + 1];
      i += 1;
    }
    out.push(t);
  }
  return out;
}

/** Compute the spec §1 tuple from any live title (or slug-decoded query). */
function computeCanonicalFields(title: string): CanonicalFields {
  const tokens = canonicalTokens(title);

  // REEA-254 — the brand ROLE is evidence only when a known-brand word
  // actually appears. The old fallback consumed the first token as brand even
  // when it was really the model-family opener ("iPhone 17 Pro Max …" lost
  // "iphone17" from the model line AND collided with the same device listed
  // with its brand: brand `iphone17` ≠ `apple`). With no vocabulary brand the
  // field stays empty — missing fields never block a merge (partial-match
  // rule), so the branded and unbranded spellings of one device converge on
  // the same tuple instead of forming two cards.
  let brandIdx = tokens.findIndex((t) => BRANDS.has(t));
  if (brandIdx < 0) brandIdx = -1;
  const brand = brandIdx < 0 ? "" : tokens[brandIdx];

  const line: string[] = [];
  let storage = "";
  let color = "";
  let gradeWord = "";
  let gradeLetter = "";
  let stopped = false;
  let stoppedAfterStorage = false;
  let pendingColorWord = "";

  for (let i = brandIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];

    // Grade: vocabulary word, optional single-letter grade after it
    // ("grade b" / "b" directly after the word). Never closes the model line.
    if (GRADE_WORDS.has(t) || t === "open-box") {
      if (!gradeWord) gradeWord = t === "open-box" ? "open-box" : t;
      if (tokens[i + 1] && GRADE_LETTERS.has(tokens[i + 1])) {
        gradeLetter = tokens[++i];
      }
      continue;
    }
    if (t === "grade" && tokens[i + 1] && GRADE_LETTERS.has(tokens[i + 1])) {
      gradeLetter = tokens[++i];
      continue;
    }
    if (GRADE_LETTERS.has(t) && gradeWord && !gradeLetter) {
      gradeLetter = t;
      continue;
    }

    if (RAM_QUANTITY_RE.test(t)) continue; // RAM restatement, ignored.

    const m = STORAGE_RE.exec(t);
    if (m) {
      // A number qualified as RAM right after it ("12gb ram" arriving as
      // separate tokens) is a RAM restatement, not storage (§1 step 2).
      const nx = tokens[i + 1];
      if (nx !== undefined && RAM_WORDS.has(nx)) continue;
      if (!storage) {
        storage = t;
        stopped = true;
        stoppedAfterStorage = true;
      }
      continue;
    }

    if (COLORS.has(t)) {
      color = t;
      stopped = true;
      continue;
    }

    // Standalone quantities restate what the joined tokens already carry:
    // integer model numbers ride on their word ("fold7"), sizes restate the
    // display ("6.9", REEA-205 — quoted or spelled, like RAM/CPU restatements
    // above). Capacity tokens keep discriminating through STORAGE_RE.
    if (NOISE.has(t) || /^\d+(?:\.\d+)?$/.test(t)) continue;

    if (!stopped) {
      // Single-letter model-line parts ("Galaxy Z Fold7") stay in the line;
      // short one-letter junk only matters once the line has stopped.
      line.push(t);
      continue;
    }
    if (t.length < 2) continue;
    // After the line stopped at storage, an unknown word may be a colour the
    // vocabulary doesn't cover — keep the first such word verbatim (§1).
    if (stoppedAfterStorage && !color && !pendingColorWord && /^[a-z][a-z0-9]*$/.test(t)) {
      pendingColorWord = t;
    }
  }

  // Grade parts join with "-" so "Renewed Grade B" lands on the spec value
  // renewed-grade-b; absent grade means new; a lone grade letter stands alone.
  const gradeParts: string[] = [];
  if (gradeWord) gradeParts.push(gradeWord);
  if (gradeLetter) gradeParts.push("grade-" + gradeLetter);

  return {
    brand,
    modelLine: line.join(" "),
    storage,
    color: color || pendingColorWord,
    grade: gradeParts.join("-") || "new",
  };
}

/**
 * REEA-254 — title → tuple mapping cache. The same live title is re-read on
 * every merge comparison and per color swatch within one query; a bounded
 * insertion-ordered map makes the mapping a stable function for the whole
 * query, so consecutive loads of one fetched set converge on the identical
 * merge. Entries are frozen at compute time — callers copy the tuple before
 * seeding group fields (see buildGroups), so a cached value is never mutated.
 */
const FIELD_CACHE_MAX = 256;
const fieldCache = new Map<string, CanonicalFields>();

export function canonicalFields(title: string): CanonicalFields {
  const cached = fieldCache.get(title);
  if (cached !== undefined) return cached;
  const fields = computeCanonicalFields(title);
  if (fieldCache.size >= FIELD_CACHE_MAX) {
    // Oldest-first eviction keeps the window on the titles the live fan-out
    // actually carries; a miss just recomputes — nothing is bundled.
    const oldest = fieldCache.keys().next();
    if (!oldest.done) fieldCache.delete(oldest.value);
  }
  fieldCache.set(title, fields);
  return fields;
}

/** Join non-empty fields with `|` (spec §1 step 4). */
export function canonicalKey(title: string): string {
  const f = canonicalFields(title);
  return [f.brand, f.modelLine, f.storage, f.color, f.grade]
    .filter((v) => v !== "")
    .join("|");
}

/**
 * Group-membership equality. Exact equality of every field non-empty on BOTH
 * sides: missing fields never block a merge (partial-match rule), present
 * ones must agree — different storage/color/grade/model-line stay separate.
 */
export function compatibleFields(a: CanonicalFields, b: CanonicalFields): boolean {
  const pairs: [string, string][] = [
    [a.brand, b.brand],
    [a.modelLine, b.modelLine],
    [a.storage, b.storage],
    [a.color, b.color],
    [a.grade, b.grade],
  ];
  for (const [x, y] of pairs) {
    if (x !== "" && y !== "" && x !== y) return false;
  }
  // A key with neither model line nor storage is too generic to merge on
  // brand alone: require the rest of the visible fields to speak up.
  if (a.modelLine === "" && b.modelLine === "" && a.storage === "" && b.storage === "") {
    return (a.color === "" || b.color === "") || a.color === b.color;
  }
  return true;
}

/** Badge copy for the grade chip: renewed-grade-b → "Renewed Grade B". */
export function gradeBadgeLabel(grade: string): string | null {
  if (!grade || grade === "new") return null;
  return grade
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
