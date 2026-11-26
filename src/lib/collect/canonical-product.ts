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

import { isAccessoryTitle, normalizeArabicText } from "@/lib/relevance";

export interface CanonicalFields {
  brand: string;
  modelLine: string;
  /** REEA-1162 — the console/platform the SKU is sold for (`ps5`, `ps4`, …),
   *  extracted separately from the model line. Retailers disagree on where
   *  they spell it ("Sony PS5 DualSense Wireless Controller" vs "Sony
   *  DualSense PS5 Controller"); leaving it in the model line at whatever
   *  position the retailer chose forked one controller into several cards.
   *  As its own field the partial-match rule still folds a spelling that omits
   *  it, while two DIFFERENT platforms ("EA FC 27 PS5" vs "EA FC 27 PS4")
   *  never blend. Empty when the title names no platform. */
  platform: string;
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
  // REEA-1109 — the same role for appliance/gaming official colour names the
  // live W48 panel carries: a Dyson HD16 "Apricot Topaz"/"Amber Silk" and a
  // PS5 DualSense "Chroma Teal"/"Chroma Pearl" are one model in another
  // colour. An unrecognized colour word used to ride in the MODEL LINE and
  // fork one SKU into a separate single-retailer card per colour (live
  // 9c66a12: four Dyson HD16 cards and zero comparison depth). Colour is not
  // identity (REEA-254 merges on model+storage), so recognizing it here is
  // what lets the merge pass fold the colours inside one card.
  "teal", "amber", "apricot", "pearl",
  // REEA-1140 — official colour names that also stand alone (no modifier):
  // a "… Lavender" or "… Graphite" spelling is a colourway of the same SKU and
  // must not fork into its own card. They stay out of COLOR_PREFIXES because
  // they are base colours, not modifiers of another colour word.
  "lavender", "graphite", "obsidian", "sage", "coral", "mint", "sand",
  // REEA-1162 — DualSense official colourways QA sampled live that were
  // still forking their own card: "… Controller Emerald (Pre-Order)" and
  // "Chroma Indigo" (the modifier pair kept "chroma" in the model line when
  // the base word was unknown). They are base colours, not modifiers.
  "emerald", "indigo",
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
  // REEA-1109 — appliance/gaming official names arrive as modifier + base
  // exactly like the entries above ("Chroma Teal" → teal, "Galactic Purple"
  // → purple, "Ceramic Pink" → pink). Without the modifier entry the pair
  // stays in the model line and the same DualSense/Dyson SKU forks per colour
  // (live 9c66a12: three PS5 controller cards, none comparison-ready).
  "chroma", "galactic", "ceramic",
  // REEA-1140 — "Alpine Green" (Eureka's DualSense spelling) is the same
  // modifier + base pair: "alpine" stayed in the model line and forked one
  // controller into a standalone single-retailer card in every collection.
  // The rest are the same official-name class retailers spell live
  // ("Sierra Blue", "Graphite Black", "Storm Blue"); keeping the vocabulary
  // current fixes the class instead of the one reported instance.
  "alpine", "sierra", "ultramarine", "seafoam",
  "storm", "ocean", "forest",
  // REEA-1162 — the remaining DualSense official-name modifiers the live
  // shelf carried ("Volcanic Red", "Flare Orange", "Techno Red", "Nova Pink",
  // "Sterling Silver"). Same modifier + base class as the entries above: an
  // unrecognized modifier rode in the model line and forked the controller
  // into a standalone single-retailer card. "nova"/"sterling" only collapse
  // when a known base colour follows, so a model word ("Nova 5T") is safe.
  "volcanic", "flare", "techno", "nova", "sterling",
  // REEA-1162 — the live ps5 shelf also carried a "… Controller PS5 - Remix
  // Green" colourway. Same modifier + base class; "remix" only collapses when
  // a known base colour follows, so a "Remix" model word is safe.
  "remix",
]);

const GRADE_WORDS = new Set(["new", "renewed", "refurbished", "opened"]);
const GRADE_LETTERS = new Set(["a", "b", "c", "d"]);

/** REEA-1162 — platform/console names. These are IDENTITY when they
 *  discriminate a SKU ("EA FC 27 PS5" ≠ "EA FC 27 PS4"), but the position
 *  inside the title is retailer chrome: "Sony PS5 DualSense Wireless
 *  Controller", "Sony DualSense PS5 Controller" and "Sony PlayStation 5
 *  DualSense Wireless Controller" are one controller. The head-position
 *  shelf-code skip already dropped a leading `ps5`; the same token mid-title
 *  stayed in the model line and forked the merged card (live QA: the base
 *  card present only 3/6 collections, colourways rendered as their own
 *  cards). Extracting the platform into its own field makes the token
 *  position-independent without inventing identity: the partial-match rule
 *  folds a spelling that omits it, and two different platforms never merge. */
const PLATFORM_TOKENS = new Set([
  "ps3", "ps4", "ps5",
  "playstation", "playstation3", "playstation4", "playstation5",
  "xbox", "xboxone",
]);

/** The platform role for a token, canonicalised so `ps5` and `playstation5`
 *  agree (the tokenizer joins "PlayStation 5" → `playstation5`). Empty when
 *  the token is not a platform name. */
function platformOfToken(token: string): string {
  if (!PLATFORM_TOKENS.has(token)) return "";
  if (token === "playstation") return "playstation";
  if (token.startsWith("playstation")) return `ps${token.slice("playstation".length)}`;
  return token;
}

/** The platform a raw title names. A bare "PlayStation"/"Xbox" is the weak
 *  form of the role ("PlayStation (PS5)" arrives as two tokens); a numbered
 *  console token is the specific one and wins, so the same console spelled
 *  either way lands on the same platform value. Deterministic: first specific
 *  token in title order, else the first weak one. */
function platformOfTokens(tokens: readonly string[]): string {
  let weak = "";
  for (const token of tokens) {
    const platform = platformOfToken(token);
    if (!platform) continue;
    if (platform !== "playstation" && platform !== "xbox") return platform;
    if (!weak) weak = platform;
  }
  return weak;
}

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
  // REEA-1109 — appliance descriptors and connector spec restatements. The
  // live W48 panel carried "Dyson Supersonic Nural Hair Dryer HD16" beside
  // "Dyson Supersonic Nural HD16" (same SKU, four colour cards) and "JBL
  // Tune 500 On-Ear Headphones, … 3.5 mm Connector, In-line Microphone"
  // beside "JBL Tune 500 On Ear Headphones" (same SKU at Jarir + Danube).
  // The words below restate the device class / the plug, never the identity,
  // exactly like the device-type nouns and connectivity suffixes above; the
  // model code before them still discriminates (V8 Absolute ≠ V8 Origin).
  "hair", "dryer", "vacuum", "cleaner", "cordless",
  "mm", "connector", "line", "on", "ear",
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
  // REEA-1162 — the platform role is read off the RAW token stream, before the
  // head-position shelf-code skip can drop a leading `ps5`, and its tokens are
  // then removed from the model-line scan so the same controller spelled
  // "Sony PS5 DualSense…" / "Sony DualSense PS5…" / "Sony PlayStation 5
  // DualSense…" lands on ONE model line. The field itself still discriminates
  // a real platform split (PS5 vs PS4 game) through compatibleFields.
  const rawTokens = canonicalTokens(title);
  const platform = platformOfTokens(rawTokens);
  const tokens = identityTokens(rawTokens.filter((t) => !PLATFORM_TOKENS.has(t)));

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

    // REEA-1109 — Xcite spells the capacity glued to the device word
    // ("Samsung Galaxy Z Fold7 5G 512Phone - Black" = the 512 GB phone). The
    // tokenizer leaves it as `512phone`, which is neither a storage token nor
    // noise, so it rode in the model line and forked the 512 GB tier into a
    // separate single-retailer card beside the merged 512 GB card. Normalise
    // the glued form onto the storage slot it names.
    const gluedStorage = /^(\d{2,4})phone$/.exec(t);
    if (gluedStorage) {
      if (!storage) {
        storage = `${gluedStorage[1]}gb`;
        stopped = true;
        stoppedAfterStorage = true;
      }
      continue;
    }

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

  // REEA-1178 — a title whose brand token is its LAST word leaves the
  // post-brand scan empty ("Soundcore AeroFit 2 Open-Ear Wireless Earbuds -
  // Anker"), so the tuple had no model line and every merge comparison fell
  // back to the partial-match rule. The card's identity was then borrowed
  // from whichever other member title carried one — live `fb1747d2`: the
  // Anker AeroFit 2 card's slug was derived from an Amazon.eg accessory
  // ("… P47M Cat LED Over Stereo Music Card Support Kids Girls PC") and
  // changed between collection runs. When nothing follows the brand, the
  // head words BEFORE it ARE the product line the shopper sees; read them
  // through the same attribute filters so the title yields its own stable
  // model line instead of borrowing a neighbour's.
  if (line.length === 0 && brandIdx > 0) {
    for (let i = 0; i < brandIdx; i++) {
      const t = tokens[i];
      if (noised(t) || brandOf(t) !== "") continue;
      if (RAM_QUANTITY_RE.test(t)) continue;
      const glued = /^(\d{2,4})phone$/.exec(t);
      if (glued) {
        if (!storage) storage = `${glued[1]}gb`;
        continue;
      }
      if (STORAGE_RE.test(t)) {
        if (!storage) storage = t;
        continue;
      }
      if (COLORS.has(t)) {
        if (!color) color = t;
        continue;
      }
      if (GRADE_WORDS.has(t) || t === "open-box") {
        if (!gradeWord) gradeWord = t;
        continue;
      }
      if (GRADE_LETTERS.has(t) && gradeWord && !gradeLetter) {
        gradeLetter = t;
        continue;
      }
      if (/^\d+(?:\.\d+)?$/.test(t)) continue;
      line.push(t);
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
    platform,
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
  // REEA-1162 — the platform slot rides after the model line when the title
  // names one; an empty platform is dropped exactly like every other missing
  // field, so the pinned spec examples keep their key shape.
  return [f.brand, f.modelLine, f.platform, f.storage, f.color, f.grade === "new" ? "" : f.grade]
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
    // REEA-1162 — a platform named on BOTH sides must agree ("EA FC 27 PS5" ≠
    // "EA FC 27 PS4"); a spelling that omits it still joins through the
    // partial-match rule, exactly like a missing storage/colour.
    [a.platform, b.platform],
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
 * REEA-1167 — the group-membership rule the results merge uses, lifted here
 * so every consumer of "the same product" (the grouping pass and the
 * seen-recently roll-up) reads ONE identity. Colours merge (REEA-254: colour
 * is not identity), the rest of the tuple must agree under the partial-match
 * rule above.
 */
export function mergeCompatible(a: CanonicalFields, b: CanonicalFields): boolean {
  if (!compatibleFields({ ...a, color: "" }, { ...b, color: "" })) return false;
  if (a.modelLine === "" && b.modelLine === "" && a.storage === "" && b.storage === "") {
    return compatibleFields(a, b);
  }
  return true;
}

/**
 * REEA-1167 — the merge identity a live listing was grouped under: the
 * canonical field tuple (with the URL-seeded capacity buildGroups applies)
 * plus the REEA-192 accessory class, because an accessory never folds into
 * the device card it fits. Computed only from the listing's own title/url —
 * no bundled data, no extra hop.
 */
export interface ListingIdentity {
  fields: CanonicalFields;
  /** True for the accessory class (case / cover / protector / …). */
  accessory: boolean;
}

export function listingIdentity(title: string, url?: string): ListingIdentity {
  const fields = canonicalFields(title);
  const fromUrl = fields.storage || !url ? "" : storageFromListingUrl(url);
  return {
    fields: fromUrl ? { ...fields, storage: fromUrl } : fields,
    accessory: isAccessoryTitle(title),
  };
}

/** True when two listings belong to the same card under the merge rule. */
export function sameListingIdentity(a: ListingIdentity, b: ListingIdentity): boolean {
  if (!a?.fields || !b?.fields) return false;
  if (a.accessory !== b.accessory) return false;
  return mergeCompatible(a.fields, b.fields);
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

/**
 * REEA-1147 — the model-family display title for the served results page.
 *
 * A shopper searching an exact model ("samsung galaxy s25 ultra", "fold 7")
 * is comparing THAT model, not one retailer's capacity/colour tier. The
 * canonical key keeps storage as a card discriminator (REEA-254), which on a
 * live panel split one model into one single-retailer card per tier: Xcite
 * carried 256GB, Wibi 512GB, Eureka 1TB, so no card could show two stores.
 * The results-page grouping folds those tier groups into one family card and
 * this helper names it: the member title with capacity, colour, grade, RAM
 * and marketing restatements removed. Every word comes from the fetched
 * retailer title — nothing bundled, nothing invented.
 *
 * The glued Xcite spelling ("512Phone", REEA-1109) is removed too, so a
 * family title never keeps one tier's number. When removal leaves nothing
 * usable the caller falls back to the verbatim shortest title.
 */
export function familyDisplayTitle(listingTitle: string): string {
  const bare = (w: string): string =>
    w.toLowerCase().replace(/^[(\[{“"'‘]+/, "").replace(/[)\]},.;:!؟”"'’]+$/, "");
  const words = (t: string): string[] => t.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const kept: string[] = [];
  for (const word of words(listingTitle)) {
    const t = bare(word);
    if (t === "" || !/[\p{L}\p{N}]/u.test(t)) continue;
    if (STORAGE_RE.test(t) || /^\d{2,4}phone$/.test(t)) continue; // capacity tier / glued tier
    if (RAM_QUANTITY_RE.test(t) || RAM_WORDS.has(t) || /^(gb|tb|mb)$/i.test(t)) continue;
    if (COLORS.has(t) || COLOR_PREFIXES.has(t)) continue;
    if (GRADE_WORDS.has(t) || GRADE_LETTERS.has(t) || t === "grade") continue;
    if (arabicNoise(t) || NOISE.has(t)) continue;
    kept.push(word.trim());
  }
  const numericOnly = (w: string): boolean => /^\p{N}+(?:[.,]\p{N}+)?$/u.test(bare(w));
  while (kept.length > 0 && numericOnly(kept[0])) kept.shift();
  while (kept.length > 0 && numericOnly(kept[kept.length - 1])) kept.pop();
  return kept.join(" ");
}

/**
 * REEA-1147 — the visible capacity qualifier of a listing ("256 GB"), read
 * from the same STORAGE_RE/glued vocabulary as the canonical key. Empty when
 * the title names no capacity. Used only on family cards, where capacity is
 * an offer-row qualifier rather than the card-splitting discriminator.
 */
export function capacityLabelOf(listingTitle: string): string {
  const storage = canonicalFields(listingTitle).storage;
  if (storage === "") return "";
  const m = /^(\d+(?:\.\d+)?)(gb|tb)$/.exec(storage);
  if (!m) return "";
  return `${m[1]} ${m[2].toUpperCase()}`;
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

/* ---- REEA-1140: one canonical slug per merged SKU ---------------------- */

/**
 * The storage tier a retailer's own listing URL names. Retailer PDP slugs are
 * generated from the listing title, so a live URL like
 * `…/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p` carries the capacity even
 * when the scraped title omits it ("Samsung Galaxy Z Fold7, 5G, 12 GB RAM").
 * The URL is fetched live with the same listing, so this is still query-time
 * retailer evidence — not a bundled alias table. A quantity qualified as RAM
 * ("12-gb-ram") is restated memory, never storage, exactly like the title
 * rule in `computeCanonicalFields`.
 */
export function storageFromListingUrl(url: string): string {
  if (!url) return "";
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  // 1–4 digits: a 1 TB tier is spelled `1-tb` in several retailer slugs.
  // A slug can name RAM and storage together ("…-12gb-256gb"); RAM quantities
  // are smaller (4–24 GB) and a TB is always storage, so the largest capacity
  // the slug names is the storage tier, never the memory figure.
  let best = "";
  let bestRank = -1;
  for (const match of path.matchAll(/(\d{1,4})[\s_-]?(gb|tb)(?![\s_-]?ram)/g)) {
    const value = Number(match[1]);
    const rank = match[2] === "tb" ? 1_000_000 + value : value;
    if (rank > bestRank) {
      best = `${match[1]}${match[2]}`;
      bestRank = rank;
    }
  }
  return best;
}

function slugifyIdentity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * REEA-1140 — the canonical SKU slug shared by the results card and the PDP
 * aggregation. It is derived from the MERGE IDENTITY (brand + model line +
 * storage + grade), never from whichever retailer title happened to arrive
 * first: two collections of one SKU therefore land on the same slug even when
 * their member titles (and the shortest-title pick) differ. That is what makes
 * `/product/<slug>` resolvable back to the SAME merged group instead of a
 * different model.
 *
 * Colour is identity only for a tuple with neither model line nor storage
 * (REEA-254: colourways ride inside one device card, so colour must not fork
 * the slug). When the title omits the capacity, the listing URLs the group
 * already carries are the tier evidence — a fold 7 256 GB card stays
 * `…-256gb` instead of flipping to a storage-less slug on a collection whose
 * title only says "12 GB RAM".
 *
 * Pure: same identity + URLs → same slug, every render, both locales.
 *
 * REEA-1162 — the platform slot is part of the slug when the SKU names one:
 * "EA FC 27 PS5" and "EA FC 27 PS4" are two cards and must keep two slugs, so
 * a platform-free slug would collide their productIds. For a SKU whose every
 * live spelling names the platform (the DualSense feed always says PS5) the
 * slug is still a pure function of the fetched identity — same slug every
 * collection — and a spelling that omits the platform resolves through the
 * partial-match fallback (product-identity.ts).
 */
export function productSlugFor(
  fields: CanonicalFields,
  offerUrls: readonly string[] = [],
  fallbackTitle = "",
): string {
  let storage = fields.storage;
  if (!storage) {
    for (const url of offerUrls) {
      const fromUrl = storageFromListingUrl(url);
      if (fromUrl) {
        storage = fromUrl;
        break;
      }
    }
  }
  const parts: string[] = [];
  if (fields.brand) parts.push(fields.brand);
  if (fields.modelLine) parts.push(fields.modelLine);
  if (fields.platform) parts.push(fields.platform);
  if (storage) parts.push(storage);
  if (fields.grade && fields.grade !== "new") parts.push(fields.grade);
  if (!fields.modelLine && !storage && fields.color) parts.push(fields.color);
  const slug = slugifyIdentity(parts.join(" "));
  return slug || slugifyIdentity(fallbackTitle);
}

/* ---------------------------------------------------------------------------
 * REEA-1178 — one card per productId: the collision pass.
 *
 * Root cause of the duplicate cards on `/results?q=iphone%2017%20pro` (10
 * cards for 8 productIds on `fb1747d2`): a "+ Wireless Charger" bundle is
 * ACCESSORY-classed (the REEA-192 class gate sees "charger"), so it forms its
 * own group — but the slug is built from the canonical tuple only, and the
 * bundle's tuple IS the base phone's (brand apple / iphone 17 pro / 256gb).
 * Two groups, one productId: the same phone painted twice at two prices.
 *
 * The class gate is part of identity, so the slug must be too. When two groups
 * collide, the DEVICE-class group keeps the plain slug (that is the product
 * the shopper searched for) and each accessory-class group takes its own
 * deterministic class suffix — "bundle" when its own titles or listing URLs
 * say so (Wibi serves `bundle-offer-apple-iphone-17-pro-…`), else
 * "accessory". A further collision between two same-class groups gets a
 * stable ordinal ordered by their own titles, so the same fetched set always
 * produces the same ids.
 * ------------------------------------------------------------------------- */

/** The class suffix that separates an accessory-classed group from the device
 *  card it shares a canonical tuple with. Reads the REEA-787 BUNDLE_WORDS
 *  vocabulary above (titles AND listing URLs — Wibi spells the bundle in the
 *  URL: `/products/bundle-offer-…`). */
export function identityClassToken(
  titles: readonly string[],
  urls: readonly string[] = [],
): string {
  const tokens = [...titles, ...urls].flatMap((text) => canonicalTokens(text));
  return tokens.some((t) => BUNDLE_WORDS.has(t)) ? "bundle" : "accessory";
}

export interface GroupSlugInput {
  /** The base slug the group's canonical tuple produces. */
  slug: string;
  /** REEA-192 class of the group (accessory titles never fold into a device). */
  accessory: boolean;
  /** The group's own member titles and listing URLs — its live evidence. */
  titles: readonly string[];
  urls: readonly string[];
}

/**
 * REEA-1178 AC1 — the served payload's productIds, guaranteed pairwise
 * distinct: the device-class group wins a contested slug, accessory groups
 * are disambiguated from their own evidence, and any residual tie (two
 * bundles of one SKU) breaks on a stable ordinal. Pure and deterministic on
 * the fetched set — no ids leave the payload, nothing is bundled.
 */
export function uniqueGroupSlugs(groups: readonly GroupSlugInput[]): string[] {
  const out: string[] = groups.map(() => "");
  const taken = new Set<string>();
  const order = groups
    .map((group, index) => ({ group, index }))
    .sort(
      (a, b) =>
        Number(a.group.accessory) - Number(b.group.accessory) ||
        a.group.titles.slice().sort().join("|").localeCompare(b.group.titles.slice().sort().join("|")) ||
        a.index - b.index,
    );
  for (const { group, index } of order) {
    const base = group.slug || `live-${index}`;
    let slug = base;
    if (taken.has(slug)) {
      const cls = identityClassToken(group.titles, group.urls);
      slug = `${base}-${cls}`;
      let ordinal = 2;
      while (taken.has(slug)) slug = `${base}-${cls}-${ordinal++}`;
    }
    taken.add(slug);
    out[index] = slug;
  }
  return out;
}

