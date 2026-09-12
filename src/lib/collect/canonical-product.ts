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
 *     splitting it, while different storage/color/grade never do. The model
 *     line agrees under head containment too (REEA-280): a short family
 *     spelling covers the retailer-tailed long spelling of the same line.
 */

import { normalizeArabicText } from "@/lib/relevance";

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

/** Spec §1 color vocabulary — exact words, casing/space noise already gone.
 *  REEA-280 extends the set with the official names retailers spell after the
 *  line tokens ("Plum"); they close the colour field instead of riding on the
 *  model line and splitting one SKU across its own colours. */
const COLORS = new Set([
  "silver", "black", "white", "blue", "green", "gray", "grey", "gold", "red",
  "violet", "beige", "orange", "purple", "pink", "plum",
]);

/** Modifier words that open a two-word official colour name (§1 step 2):
 *  "cobalt violet" → violet, "titanium black" → black. The base colour itself
 *  is matched through COLORS; a known base followed by a modifier ("silver
 *  shadow") needs no prefix entry — the scan closes the colour on "silver" and
 *  ignores the trailing word after the stop. */
const COLOR_PREFIXES = new Set([
  "cobalt", "titanium", "phantom", "cosmic", "midnight", "starlight", "jet",
  "sky", "ice", "desert", "mist", "frost", "lava", "solar", "aurora",
  // REEA-280: Bose's official QC II names ("Eclipse Grey", "Twilight Blue")
  // arrive as modifier + base; they close the colour exactly like the
  // existing prefix pairs, not as extra model-line words.
  "eclipse", "twilight",
  // REEA-486: Apple-style "Deep Blue"/"Deep Purple" — same modifier + base
  // pair; the modifier must not fork the short spelling into a second card.
  "deep",
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
  // REEA-254: Jarir-style tail clauses ("with Face ID | Tax Paid | 2 Years
  // Official Warranty") restate warranty/setup marketing, never a product
  // attribute — same role as the spec restatements above.
  "face", "id", "tax", "paid", "warranty", "years", "official",
  // REEA-280: Apple-store-style tails ("Apple Intelligence") join the same
  // marketing class — the chip/features restatements above. They ride AFTER
  // the model line and split one SKU into two cards when a retailer omits
  // them and the Apple-store listing carries them.
  "intelligence",
  // REEA-310: keyboard descriptor words ("RGB Wired Gaming Mechanical
  // Optical") restate the same hardware across retailer spellings; the
  // colour outside them is what makes one SKU distinct. Same role as the
  // spec restatements above.
  "gaming", "wired", "rgb", "mechanical", "optical",
  // REEA-280: the same class on earbud/TV listings — "Noise Cancelling
  // Microphone, Bluetooth, USB (Charging), Built-in Microphone" restates
  // the connectivity the model line already implies, and a retailer that
  // omits the tail must not fork the short spelling into a second card.
  // "in" rides with the join-word class ("Built-in" splits to "built in").
  "wireless", "bluetooth", "microphone", "noise", "cancelling", "usb",
  "built", "smart", "ai", "vision", "in", "cellular",
  // REEA-316: the Jarir-style spec tail on peripheral listings — "Mechanical
  // Switch Gaming Keyboard, Bluetooth/Wireless (2.4 GHz RF)/Wired, for
  // Laptop/Desktop Computer/CPU Windows 10 or Later" — is one long
  // connectivity/use-case restatement of the same device. Every word of it
  // rides in the class above: the switch type, the radio bands, the join
  // words, and the host-device nouns the keyboard merely plugs into. A
  // retailer that writes the tail must not fork the short spelling into a
  // second card. Digit-tailed spellings ("windows10") reach the field scan
  // through the join pass; noised() below reads them back to their word.
  "switch", "ghz", "rf", "for", "or", "later", "cpu", "desktop", "computer",
  "windows",
  // REEA-254's brand-restatement rule applied to sub-brand markers: "ROG"
  // restates the ASUS gaming brand line the brand field already carries —
  // exactly like the repeated brand word inside one title — while retailers
  // disagree on whether they spell it out at all ("Asus Strix Scope II X …"
  // vs "ASUS ROG STRIX SCOPE II X …"). One SKU must not fork on that.
  // Line-defining series words (TUF, VivoBook, …) are NOT in this class —
  // they stay visible in the model line.
  "rog",
  // REEA-486: region/version qualifiers — the same listing-chrome class as
  // "global"/"version"/"unlocked". A tail like "Japanese Version (eSIM)"
  // restates the line the head already carries; the short spelling must
  // cover it while the qualifier survives INSIDE the merged card as the
  // offer's own label (see listingLabel). Latin and Arabic spellings of one
  // device read through the same fold (noised()).
  "japanese", "american", "chinese", "korean", "european", "british",
  "edition", "intl",
  "نسخة", "اصدار", "ياباني", "يابانية", "امريكي", "امريكية", "صيني",
  "صينية", "كوري", "كورية",
]);

/** Qualifier words that fold out of the identity tuple yet stay visible as
 *  the offer label inside the merged card (REA-486 AC-6): they carry no
 *  identity — the model line above them decides the card — but they tell the
 *  shopper WHICH listing of that line a row is ("Japanese Version", "eSIM").
 *  Marketing noise ("with Face ID", "Tax Paid") is NOT in this set; it rides
 *  off with the rest of the restatements. Keys are stored in the folded
 *  Arabic form normalizeArabicText produces. */
const LABEL_QUALIFIERS: ReadonlySet<string> = new Set([
  "japanese", "american", "chinese", "korean", "european", "british",
  "edition", "version", "intl", "international", "esim", "sim",
  "نسخة", "اصدار", "ياباني", "يابانية",
]);

/** NOISE membership that reads back joined word+digit tokens: the tokenizer
 *  glues a trailing figure onto its word ("Windows 10" → `windows10`), so a
 *  restatement word stays recognized after the join pass. Plain model codes
 *  keep discriminating — `air11` is not noise because "air" is not either.
 *  REEA-486: Arabic-script tokens are looked up through the same fold the
 *  Arabic matching paths use (normalizeArabicText + a leading "ال" strip), so
 *  a qualifier spelled with or without the article/hamza variants lands on
 *  the same recognition the Latin spelling gets — the Arabic card mirrors the
 *  Latin structure exactly. */
function arabicNoise(token: string): boolean {
  if (!/[\u0600-\u06FF]/.test(token)) return false;
  const folded = normalizeArabicText(token);
  if (NOISE.has(folded)) return true;
  const stripped = folded.replace(/^ال/, "");
  return stripped.length >= 3 && NOISE.has(stripped);
}

function noised(token: string): boolean {
  return (
    NOISE.has(token) ||
    (/^\p{L}+\d+$/u.test(token) && NOISE.has(token.replace(/\d+$/g, ""))) ||
    arabicNoise(token)
  );
}

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
    // REEA-310: annotation parentheses drop WITH contents — switch/layout
    // notes ("(ROG RX Red Switch)", "(Arabic Layout)") are listing chrome,
    // not product identity, and one SKU must not fork on whether a retailer
    // carries them. Colour words outside the parens survive. Brackets that
    // carry a quantity keep the REEA-254 bracket-as-space behaviour — a
    // capacity inside brackets ("(256 GB)") is an attribute restatement, not
    // chrome, and stays visible to the field scan. Stray paren characters
    // fall through to the separator class below either way.
    .replace(/\((?![^()]*\d)[^()]*\)/g, " ")
    // REEA-254: parentheses and pipes are separators too. Jarir-style titles
    // write the capacity inside brackets ("iPhone 17 Pro (256 GB)") and tail
    // marketing clauses with pipes; left as text they poison the model line
    // (`iphone17 pro (256` ≠ `iphone17 pro`) and one SKU forks into several
    // cards. As spaces they normalize exactly like the retailer's own
    // short spelling.
    .replace(/[,;:()|/+\-‒–—]/g, " ")
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

/** REEA-310 step 5 — a retailer shelf code glued right after the leading
 *  brand token(s) ("ASUS XA14 ROG STRIX …") restates the retailer's own
 *  prefix, not the product line. Generation parts keep their shape: `ii`
 *  and `x` carry no digits, `96` carries no letters. */
const SHELF_CODE_RE = /^[a-z]{1,3}[0-9]{1,3}$/;

/** REEA-310 step 7 — a one-letter switch suffix riding right after a
 *  numeral/Roman-numeral generation part restates that part
 *  ("Scope II RX" ≡ "Scope II X"). Position-scoped: applied once per pair,
 *  never chained. */
const SUFFIX_RE = /^r([a-z])$/;
const ORDINAL_RE = /^(?:\d+(?:\.\d+)?|[ivxlcdm]+)$/;

/** Run steps 5 and 7 over the token stream, before the field scan. */
function identityTokens(tokens: string[]): string[] {
  const out: string[] = [];
  // Shelf codes only inside the leading brand block at the head of the title.
  let i = 0;
  while (i < tokens.length && BRANDS.has(tokens[i])) out.push(tokens[i++]);
  while (i < tokens.length && SHELF_CODE_RE.test(tokens[i])) i++;
  for (; i < tokens.length; i++) out.push(tokens[i]);
  // Switch-suffix collapse, position-scoped.
  for (let j = 0; j + 1 < out.length; j++) {
    if (!ORDINAL_RE.test(out[j])) continue;
    const m = SUFFIX_RE.exec(out[j + 1]);
    if (m) {
      out[j + 1] = m[1];
      j++; // pair resolved — the next ordinal starts fresh
    }
  }
  return out;
}

/** Compute the spec §1 tuple from any live title (or slug-decoded query). */
function computeCanonicalFields(title: string): CanonicalFields {
  const tokens = identityTokens(canonicalTokens(title));

  // REEA-254 — the brand ROLE is evidence only when a known-brand word
  // actually appears. The old fallback consumed the first token as brand even
  // when it was really the model-family opener ("iPhone 17 Pro Max …" lost
  // "iphone17" from the model line AND collided with the same device listed
  // with its brand: brand `iphone17` ≠ `apple`). With no vocabulary brand the
  // field stays empty — missing fields never block a merge (partial-match
  // rule), so the branded and unbranded spellings of one device converge on
  // the same tuple instead of forming two cards.
  // REEA-280: the tokenizer joins a size figure to the word before it
  // ("Samsung 55" → `samsung55`), so the role also reads through the digit
  // tail — the brand FIELD keeps the vocabulary word itself, so a titled
  // "Samsung 75" and a titled "Samsung" agree on `samsung`.
  const brandOf = (t: string): string => {
    if (BRANDS.has(t)) return t;
    const stem = t.replace(/\d+$/, "");
    return BRANDS.has(stem) ? stem : "";
  };
  let brandIdx = tokens.findIndex((t) => brandOf(t) !== "");
  if (brandIdx < 0) brandIdx = -1;
  const brand = brandIdx < 0 ? "" : brandOf(tokens[brandIdx]);

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
    // REEA-280: a repeated brand word inside one title ("iPad Air … Apple
    // Intelligence …") restates the brand field the same way — the role is
    // evidence once (REEA-254), echoes carry no model-line information.
    if (noised(t) || brandOf(t) !== "" || /^\d+(?:\.\d+)?$/.test(t)) continue;

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

/**
 * Join non-empty fields with `|` (spec §1 step 4). REEA-310: the default
 * grade carries no identity — §1 itself defines an absent grade as `new`,
 * and the join rule already drops empty fields, so the default rides in the
 * rendered key exactly like a missing one. An explicit grade
 * ("renewed-grade-b") still discriminates. Field-level equality is
 * unchanged: compatibleFields compares the tuple, not this string.
 */
export function canonicalKey(title: string): string {
  const f = canonicalFields(title);
  return [f.brand, f.modelLine, f.storage, f.color, f.grade === "new" ? "" : f.grade]
    .filter((v) => v !== "")
    .join("|");
}

/**
 * REEA-280 — model-line containment. One retailer truncates its tail while
 * another appends listing chrome ("Crystal UHD U8000F Smart TV" vs
 * "... 4K Smart TV UA75U8000FUXZN"). The shorter line must sit at the head
 * of the longer one, token by token, and everything the long side adds after
 * it must be LISTING CHROME: a noise/descriptor word, a colour word, a lone
 * letter, or a retailer code shape (letters + digits — "ua75u8000fuxzn").
 * A plain word is identity: "Pro" vs "Pro Max" (REA-213 tiering) keeps two
 * cards. At the head position, two retailer-code tokens agree when one is a
 * prefix of the other — the shelf suffix ("...uxzn") restates the family
 * code ("u8000f" shape), it does not fork the SKU.
 */
const CODE_SHAPE = /^(?:[a-z]{1,3}\d|\d[a-z]{1,3}\d)/;

function isCodeShape(token: string): boolean {
  return CODE_SHAPE.test(token) && /\d/.test(token) && /[a-z]/.test(token);
}

/** A lone chrome word may ride after the shared head of the shorter line. */
function isChromeWord(token: string): boolean {
  return noised(token) || COLORS.has(token) || COLOR_PREFIXES.has(token) || /^[a-z]$/.test(token);
}

/** Two shelf codes of one family agree when the SHORTER one's digit run and
 *  letter run both appear in the longer ("8000f" rides inside
 *  "ua75u8000fuxzn", the retailer's regional suffix), while sibling codes
 *  still disagree: different digits ("7000" vs "8000") or different letters
 *  ("a25" vs "s25") break one of the two runs. */
function codesAgree(a: string, b: string): boolean {
  const [shortTok, longTok] = a.length <= b.length ? [a, b] : [b, a];
  if (longTok.startsWith(shortTok)) return true;
  const digits = (s: string): string => s.replace(/\D/g, "");
  const letters = (s: string): string => s.replace(/\d/g, "");
  const sd = digits(shortTok);
  return sd.length >= 2 && digits(longTok).includes(sd) && letters(longTok).includes(letters(shortTok));
}

function headTokensAgree(shortToken: string, longToken: string): boolean {
  if (shortToken === longToken) return true;
  if (shortToken.length >= 2 && longToken.startsWith(shortToken)) return true;
  if (shortToken.length >= 2 && shortToken.startsWith(longToken)) return true;
  // Two shelf codes of one family: the shorter code's digit + letter runs
  // ride inside the suffixed one.
  return isCodeShape(shortToken) && isCodeShape(longToken) && codesAgree(shortToken, longToken);
}

function lineCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const at = a.split(" ");
  const bt = b.split(" ");
  const [short, long] = at.length <= bt.length ? [at, bt] : [bt, at];
  if (!short.every((t, i) => headTokensAgree(t, long[i] ?? ""))) return false;
  // The long tail must be chrome only — a real word extends the identity.
  return long.slice(short.length).every((t) => isChromeWord(t) || isCodeShape(t));
}

/**
 * Group-membership equality. Exact equality of every field non-empty on BOTH
 * sides: missing fields never block a merge (partial-match rule), present
 * ones must agree — different storage/color/grade/model-line stay separate.
 * REEA-280: the model line agrees under containment too (lineCompatible),
 * one short head spelling over several long retailer tails.
 */
export function compatibleFields(a: CanonicalFields, b: CanonicalFields): boolean {
  const pairs: [string, string][] = [
    [a.brand, b.brand],
    [a.storage, b.storage],
    [a.color, b.color],
    [a.grade, b.grade],
  ];
  for (const [x, y] of pairs) {
    if (x !== "" && y !== "" && x !== y) return false;
  }
  if (a.modelLine !== "" && b.modelLine !== "" && !lineCompatible(a.modelLine, b.modelLine)) {
    return false;
  }
  // A key with neither model line nor storage is too generic to merge on
  // brand alone: require the rest of the visible fields to speak up.
  if (a.modelLine === "" && b.modelLine === "" && a.storage === "" && b.storage === "") {
    return (a.color === "" || b.color === "") || a.color === b.color;
  }
  return true;
}

/**
 * REEA-486 AC-6 — the per-listing qualifier that survives the merge. Once
 * several retailer spellings fold onto one card, the words THIS listing
 * carries beyond the card's own title ("Japanese Version", "eSIM") keep each
 * offer distinguishable inside the merged card. Words that already have their
 * own slot on the card ride off instead of forking one merchant's rows:
 * colours (the swatch chips), capacities (they split the tier themselves),
 * grades (the grade badge) and plain marketing restatements (the NOISE
 * class). A qualifier word from LABEL_QUALIFIERS stays visible even though it
 * is NOISE for matching — it restates nothing the shopper must compare.
 * Pure word-set difference on the two verbatim titles: same inputs, same
 * label, every render — Arabic and Latin titles run the identical path.
 */
export function listingLabel(listingTitle: string, cardTitle: string): string {
  const bare = (w: string): string =>
    w.toLowerCase().replace(/^[(\[{“"'‘]+/, "").replace(/[)\]},.;:!؟”"'’]+$/, "");
  const words = (t: string): string[] => t.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const carried = new Set(words(cardTitle).map(bare).filter((w) => w !== ""));
  const kept: string[] = [];
  for (const word of words(listingTitle)) {
    const t = bare(word);
    if (t === "" || carried.has(t)) continue;
    // Pure punctuation ("-", "/") is layout, not information.
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    if (COLORS.has(t) || COLOR_PREFIXES.has(t)) continue; // swatches own colours
    if (GRADE_WORDS.has(t) || GRADE_LETTERS.has(t) || t === "grade") continue; // the badge chip
    if (STORAGE_RE.test(t) || RAM_QUANTITY_RE.test(t) || RAM_WORDS.has(t)) continue; // tier + RAM restatement
    if (/^(gb|tb|mb)$/i.test(t)) continue; // unit words belong to the size tier
    // Qualifier words read first: they fold out of the identity tuple yet
    // stay the visible label (both scripts), before any restatement filter.
    if (LABEL_QUALIFIERS.has(t) || LABEL_QUALIFIERS.has(normalizeArabicText(t))) {
      kept.push(word.trim());
      continue;
    }
    if (arabicNoise(t) || NOISE.has(t)) continue; // restatements ride off
    kept.push(word.trim());
  }
  // Count-only numbers ("(256" of "256 GB", the "2" of "2 Years") restate
  // slots the card already owns — the label starts and ends on words.
  const numericOnly = (w: string): boolean => /^\p{N}+(?:[.,]\p{N}+)?$/u.test(bare(w));
  while (kept.length > 0 && numericOnly(kept[0])) kept.shift();
  while (kept.length > 0 && numericOnly(kept[kept.length - 1])) kept.pop();
  return axisLabel(kept.join(" "));
}

/** REEA-787 — bundle words: a listing that ships more than the bare device
 *  ("Bundle", "Kit", "Duo") is a different offer, never a restatement —
 *  these keep rows apart inside the tier fold, same role as the qualifier
 *  class below them. */
const BUNDLE_WORDS = new Set(["bundle", "bundles", "combo", "kit", "duo", "trio"]);

/**
 * REEA-787 — the variant-tier fold for retailer-row dedup. Rides listingLabel's
 * existing vocabulary (the same word classes, not a second registry): colour
 * words close into the swatch chips, shelf-code shapes restate the retailer's
 * own prefix, RAM restatements and marketing tails restate what the tier
 * already carries — all of it folds OUT of the key so three spellings of one
 * listing ("256 GB", "256GB", "256 GB - Black") collapse to one row. What
 * survives keeps rows apart: storage tiers (256gb vs 512gb), LABEL_QUALIFIERS
 * ("Japanese Version", "eSIM" — the REEA-486 AC-6 visible-label rule), and
 * bundle words. Deterministic tokenizer pass (canonicalTokens): casing,
 * punctuation and joined-unit spellings ("256 GB" ≡ "256GB") land on the same
 * key in both scripts; same inputs, same fold, every render.
 */
export function dedupVariantKey(label: string): string {
  const tokens = canonicalTokens(label);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (LABEL_QUALIFIERS.has(t) || LABEL_QUALIFIERS.has(normalizeArabicText(t))) {
      kept.push(t);
      continue;
    }
    if (BUNDLE_WORDS.has(t)) {
      kept.push(t);
      continue;
    }
    if (COLORS.has(t) || COLOR_PREFIXES.has(t)) continue; // swatch chips own colours
    if (GRADE_WORDS.has(t) || GRADE_LETTERS.has(t) || t === "grade" || t === "open-box") continue; // the grade badge rides its own key slot
    if (RAM_QUANTITY_RE.test(t) || RAM_WORDS.has(t)) continue; // RAM restatement
    if (/^\d+(?:\.\d+)?(?:gb|tb)$/i.test(t) && RAM_WORDS.has(tokens[i + 1] ?? "")) continue; // "12GB RAM" glued form: the quantity is the RAM restatement
    if (STORAGE_RE.test(t)) {
      kept.push(t);
      continue;
    }
    if (noised(t)) continue; // marketing/connectivity restatements ride off
    if (SHELF_CODE_RE.test(t) || isCodeShape(t)) continue; // retailer's own shelf prefix
    if (/^\p{N}+(?:[.,]\p{N}+)?$/u.test(t)) continue; // bare counts restate the tier
    kept.push(t); // plain words carry tier information ("Max")
  }
  return kept.join(" ");
}

/** Decode the handful of entities retailer listing titles actually ship so
 *  chips print `6.9"` and not the raw `&quot;` tail (REA-674 fix 2). */function decodeListingEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, "&");
}

/**
 * REA-674 Rule 1 — the label cap for the rebuilt qualifier chip. Retailer
 * listings pack the variation axes comma-separated ("Chip,48 Space",
 * "Galaxy S25 FE, 6.7-inch, Navy,"); the rebuilt chip never re-embeds a raw
 * comma: fragments join on single spaces. Each fragment is trimmed of
 * whitespace and dangling punctuation at BOTH ends ("Lavender," becomes
 * "Lavender"), whole fragments past the 40-character budget drop from the
 * tail — never a mid-word cut, so what survives ends on a word boundary —
 * and one oversized fragment snaps to its last word boundary inside the
 * budget. Parenthesis groups ("(GTG)", an unclosed "(ENGLISH/ARABIC") read
 * as ordinary axis fragments. Deterministic arithmetic on one string: same
 * input, byte-identical output, the identical path for EN and AR titles —
 * whitespace collapse only, RTL-safe.
 */
function axisLabel(text: string): string {
  const decoded = decodeListingEntities(text).replace(/\s+/g, " ").trim();
  if (decoded === "") return "";
  const trimTail = (s: string): string =>
    s.trim().replace(/^[-–—/:;.,\s]+/, "").replace(/[-–—/:;.,\s]+$/, "");
  const fragments = decoded
    .replace(/[)）]/g, " ")
    .split(/[,(]+/)
    .map((f) => trimTail(f.replace(/\s+/g, " ")))
    .filter((f) => f !== "");
  let label = "";
  for (const frag of fragments) {
    const next = label === "" ? frag : `${label} ${frag}`;
    if (next.length <= 40) {
      label = next;
      continue;
    }
    if (label === "") {
      // Single fragment past the cap: snap to the last word boundary inside
      // it; a lone longer word keeps its whole shape rather than cut mid-way.
      const head = frag.slice(0, 40);
      const cut = head.lastIndexOf(" ");
      label = cut > 0 ? head.slice(0, cut) : head;
    }
    break;
  }
  return label;
}

/** Badge copy for the grade chip: renewed-grade-b → "Renewed Grade B". */
export function gradeBadgeLabel(grade: string): string | null {  if (!grade || grade === "new") return null;
  return grade
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
