/**
 * REEA-180 / REEA-189 — relevance tiering + brand hygiene (Rules 1–3 of the
 * spec comment on REEA-180). Pure, deterministic helpers:
 *
 *  Rule 1 — brand resolution chain: trimmed retailer brand field wins (with
 *  casing normalized against the curated list); artifact stop-values count as
 *  missing; else a curated-list whole-word title match (longest entry first);
 *  else no brand line. Never the arbitrary first title word.
 *  Rule 2 — device-intent queries get two stacked containers (Devices above
 *  Accessories); accessory classification is a case-insensitive substring on
 *  the normalized title (EN + AR markers). Non-device queries keep the plain
 *  single-list behavior.
 *  Rule 3 — Arabic titles ride the same rules with Arabic accessory markers;
 *  matching/scoring itself lives in search-fallback.ts and stays untouched.
 */

import {
  ARABIC_BRAND_ALIASES,
  ARABIC_MODEL_ALIASES,
  arabicAliasEntryForToken,
  arabicAliasFormsForToken,
  arabicBrandForToken,
  arabicFamilyAliasesForToken,
  arabicPhraseAliasForQuery,
  arabicQueryAlias,
  arabicTokenLookupKeys,
  foldArabicForMatch,
  normalizeArabicText,
} from "@/lib/arabic-lexicon";

/** REEA-1218 — the lexicon owns the Arabic fold and the AR↔EN maps. Keep this
 *  re-export because the pre-Bet-8 matching paths (canonical tuples, title
 *  identity) import it from this module. */
export { normalizeArabicText };

/** Re-export the lexicon helpers used by the relevance/scope gates so the
 *  scope gate keeps one import surface for Arabic matching. */
export {
  arabicAliasFormsForToken,
  arabicFamilyAliasesForToken,
  arabicPhraseAliasForQuery,
  arabicQueryAlias,
  foldArabicForMatch,
};

/** Curated known-brand list (cap 75, spec §Rule 1) — brands the four
 *  retailers actually carry. Canonical casing is exactly as written here. */
export const CURATED_BRANDS: readonly string[] = [
  // Electronics / audio / computing (Xcite, Jarir, Eureka)
  "Apple", "Samsung", "Sony", "Bose", "JBL", "Sennheiser", "Anker", "Xiaomi",
  "Huawei", "Honor", "Oppo", "Vivo", "Realme", "Nothing", "Google", "Microsoft",
  "Dell", "HP", "Lenovo", "Asus", "Acer", "LG", "Toshiba", "Philips",
  "Panasonic", "Hisense", "TCL", "Sharp", "Fujifilm", "Dyson", "Braun",
  "DeLonghi", "Nespresso", "Tefal", "Kenwood", "Electrolux", "NILLKIN",
  "Araree", "RINGKE", "GRABIST", "GravaStar", "PanzerGlass",
  // Gaming peripherals Quadra Stores carries (REEA-487 brand audit).
  "Razer", "SteelSeries", "Logitech", "Corsair",
  // Desk/display brands from the same audit (fills the list to the cap).
  "Nanoleaf", "PNY", "Keychron", "BenQ",
  // Grocery / household (Sultan Center)
  "Almarai", "Al Safi", "Tamanies", "Nada", "Inver", "Cowbell", "Lipton",
  "Nescafe", "Nestle", "Kellogg's", "Nature Valley", "Coca-Cola", "Pepsi",
  "Sunkist", "Dove", "Lux", "Gillette", "Head & Shoulders", "Pantene",
  "Pampers", "Huggies", "Ariel", "Omo", "Fairy", "Cif",
];

/** Artifact stop-values: a retailer brand field holding one of these words is
 *  a listing artifact, not a brand — treat the field as missing (spec Rule 1
 *  step 1). Compared case-insensitively against the trimmed field value. */
const BRAND_STOP_VALUES: readonly string[] = [
  "Privacy", "Case", "Cover", "Clear", "Transparent", "Tech", "Compatible",
  "For", "With", "Premium", "Basic", "Original", "New",
];

/* EN + AR accessory markers (spec Rule 2). Substring match on the
   normalized lowercase title. REEA-1068 — "bundle" and "protection" join the
   list: an add-on pack or a protection ring/pack is an accessory class, not a
   device, so a cheap bundle/lens ring cannot outrank the phone set it
   complements. REEA-1068 D2 — "camera glass" and "lens" join too: the QA pass
   caught a Wibi "Smartix Ultraguard Camera Glass … for Samsung Galaxy Z
   Fold7" lens cover merging into the device card (it repeats the full device
   identity in its title), where its KD 5.50 then set the phone card's Best
   price. A bare "glass" stays OUT of the list so a glass-topped table
   ("Wansa Glass Heater Foldable Table") remains a device-class row. */
const ACCESSORY_MARKERS: readonly string[] = [
  "case", "cover", "protector", "protection", "tempered glass", "camera glass",
  "film", "skin", "lens",
  "adapter", "adaptor", "charger", "dock", "holder", "hanger", "rack",
  "eartips", "ear tips", "sleeve", "bundle",
  // REEA-1154 / REEA-1068 D4 — cables were the last accessory class with no
  // EN marker ("charger" never matches "Charging", and "cable" was absent), so
  // a "Heavy Duty 3 Meter Fast Charging 30W Cable USB A to Type-C" was classed
  // as a DEVICE and the device-first head guard kept it at #2 above the Fold7
  // phones on the served shelf. "cord" stays out on purpose: a plain substring
  // would also classify a "Cordless Vacuum" as an accessory.
  "cable",
  "كيبل",
  "كفر", "جراب", "واقي", "غطاء", "شاحن", "كابل", "وصلة", "حامل",
];

/** REEA-1154 D4 — "cord" completes the cable class, but only as a WHOLE WORD:
 *  a plain substring marker would demote a "Cordless Vacuum" or a "Record
 *  Player", both devices (the reason it stayed out of the list above).
 *  `\bcords?\b` accepts "cord"/"cords" and leaves "cordless"/"record"/"accord"
 *  alone, so a bare "USB-C Data Cord" is an accessory while a cordless device
 *  stays a device. */
const ACCESSORY_WORD_RE = /\bcords?\b/;

/** Model-number shape (spec Rule 2): letters immediately followed by digits
 *  ("WH-1000XM6", "SM-R530"). The separator class is widened to a short
 *  space/hyphen/slash gap on purpose: spaced model forms ("Galaxy Buds 3",
 *  Arabic "آيفون 17") carry the same intent, and canonicalTokens joins word +
 *  adjacent-digit pairs the same way. Superset of the spec examples — every
 *  title the spec qualifies still qualifies. */
const MODEL_TOKEN_RE = /\p{L}[\p{L}\p{M}]*[\s/-]{0,2}\p{Nd}/u;

/** Trim + collapse inner whitespace; matching happens on this form so the
 *  Arabic and EN marker lists stay simple substring checks. */
export function normalizedTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

/* ---- REEA-195: Arabic brand-token matching (query side only). ---- */

/* REEA-1218 — the AR↔EN alias maps and the Arabic fold now live in
 * lib/arabic-lexicon.ts (static asset, one curated source). The imports above
 * keep the same map names the pre-Bet-8 matching code used. */

/** Split a query into match tokens with the same tokenizer the retailer
 *  coverage gates use (Latin letters/digits + Arabic block, min length 2). */
export function queryMatchTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
        .split(" ")
        .filter((t) => t.length >= 2),
    ),
  );
}

/** REEA-1068 — compact model-number spellings. Retailer indexes carry the
 *  same model both ways ("Fold7" in one, "Fold 7" in another) and shoppers
 *  type either; a Latin word immediately followed by a SHORT digit run (a
 *  model number — 1–2 digits) folds into one token ("fold 7" → "fold7",
 *  "iphone 16" → "iphone16") so both spellings meet. Longer runs are spec
 *  quantities, not model numbers ("Pro 256 GB" must stay "pro" + "256"), and
 *  Arabic words never fold — the REEA-195 brand-alias bridge keys on the
 *  un-compacted spelling. */
function compactAdjacent(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    if (/^[a-z]+$/i.test(word) && next !== undefined && /^\d{1,2}$/.test(next)) {
      out.push(`${word.toLowerCase()}${next}`);
      i += 1;
      continue;
    }
    out.push(word);
  }
  return out;
}

/** Query-side model tokens: whitespace chunks with punctuation trimmed (so
 *  "fold, 7" folds too), compacted, Arabic-folded (so "غسّالة"/"غسالة" and
 *  "أبل"/"ابل" still meet), and deduped. Single characters survive only
 *  inside a compact form ("fold7"); a bare "7" or "z" still carries no
 *  signal on its own, exactly like queryMatchTokens. */
export function compactQueryTokens(query: string): string[] {
  const chunks = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9\u0600-\u06FF]+|[^a-z0-9\u0600-\u06FF]+$/g, ""))
    .filter(Boolean);
  // REEA-1068 — Arabic model words ride their curated Latin stem BEFORE the
  // digit adjacency folds, so "فولد 7" and "fold 7" produce the same
  // "fold7" identity token. Unknown Arabic words keep the plain path.
  const latinized = chunks.map((t) => {
    const folded = foldArabicForMatch(t);
    return ARABIC_MODEL_ALIASES.get(folded) ?? t;
  });
  return Array.from(
    new Set(
      compactAdjacent(latinized)
        .map((t) => foldArabicForMatch(t))
        .filter((t) => t.length >= 2),
    ),
  );
}

/** Title-side model words: the tier scorer and the coverage gate compare the
 *  same compacted shape, so "Samsung Z Fold 7" answers the token "fold7". */
function compactTitleWords(title: string): string[] {
  return compactAdjacent(titleWords(title));
}

/** Separator-folded form of a digit-bearing token ("fold-7" → "fold7",
 *  "WH-1000XM6" → "wh1000xm6"); equality on this form keeps hyphenated
 *  storefront spellings meeting the compact one. */
function foldModelToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** REEA-1068 — the compact spelling a spaced model query is dispatched under:
 *  when the WHOLE query is one Latin word plus one digit run ("fold 7",
 *  "Fold 7", "pixel 9"), retailer indexes answer "fold7" directly, so the
 *  shopper's spelling and the compact one collect the same payload. Longer
 *  phrases keep their spelling — the matcher folds their compact tokens, so
 *  dispatch recall is never narrowed on a guess. */
export function compactDispatchQuery(query: string): string {
  const chunks = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter(Boolean);
  if (chunks.length !== 2) return query;
  const [word, digits] = chunks;
  if (!/^[a-z]+$/.test(word) || !/^\d{1,2}$/.test(digits)) return query;
  return `${word}${digits}`;
}

/** REEA-1154 D4 — the DISPATCH identity of a shopper query: the compact Latin
 *  spelling every adapter hop is actually sent, and the identity the memo,
 *  follow-up registry and rank gate already key on (`fold 7`/`Fold 7`/`فولد 7`
 *  → `fold7`). Every serve-side consumer that decides WHAT a query is about
 *  must read this identity, not the shopper's spacing: QA measured one
 *  dispatched query rendering 10 cards on the tight spelling and 4 on the
 *  spaced one because the confidence partition still scored the raw tokens
 *  (the spaced form has no code-shaped token, so the same accessory rows were
 *  demoted to the related band). Longer phrases keep their own spelling, so
 *  this is a no-op for everything that does not fold. */
export function dispatchIdentity(query: string): string {
  return compactDispatchQuery(latinBridgeDispatch(query)).trim();
}

/** REEA-1068 — gate-side token match. Plain words and Arabic tokens keep the
 *  historical path (substring / alias bridge: descriptive retailer titles and
 *  Arabic morphology still answer). A digit-bearing token is a model code, so
 *  it must meet a real compacted title word — "fold7" no longer accepts
 *  "Foldable" merely because it starts with "fold". Model containment stays
 *  available ("xm6" answers "WH-1000XM6"), mirroring titleMatchScore's G4. */
export function matchesCompactQueryToken(titleLower: string, token: string): boolean {
  const folded = foldArabicForMatch(token);
  if (folded === "" || /[\u0600-\u06FF]/.test(folded)) {
    return matchesQueryToken(titleLower, token);
  }
  if (!/\d/.test(folded)) return matchesQueryToken(titleLower, token);
  const target = foldModelToken(folded);
  const words = compactTitleWords(titleLower).map((w) => foldArabicForMatch(w));
  return (
    words.some((w) => foldModelToken(w) === target) ||
    words.some((w) => /\d/.test(w) && foldModelToken(w).endsWith(target))
  );
}

/** REEA-1068 — the model-identity tokens in a query: letter-led tokens that
 *  carry a digit ("fold7", "iphone17", "s25", "xm6"). These name WHICH item
 *  the shopper wants, unlike spec quantities ("256gb", "5000mah", "65w" —
 *  digit-led) or bare numbers. When a query has one, a candidate that does not
 *  answer it is a different product, whatever else it shares: this is the
 *  category guard that stops "iPhone 17 Pro" admitting a RAZER mouse that only
 *  answers the loose "Pro" word. */
export function modelIdentityTokens(query: string): string[] {
  return compactQueryTokens(query).filter(
    (t) => /^[a-z][a-z0-9]*$/i.test(t) && /\d/.test(t),
  );
}

/** Gate-side model-identity match: the compact token meets a title word
 *  exactly (or as a model suffix, "xm6" in "WH-1000XM6"), or — for titles
 *  that spell the model apart ("AirPods Pro (2nd generation)" for "pro 2") —
 *  the letter stem appears as a whole word and the digit run appears in the
 *  title. The stem must be a whole word so "fold" never fires inside
 *  "Foldable". */
export function matchesModelIdentity(titleLower: string, token: string): boolean {
  if (matchesCompactQueryToken(titleLower, token)) return true;
  const target = foldModelToken(token);
  const parts = /^([a-z]+)(\d+)$/.exec(target);
  if (!parts) return false;
  const [, stem, digits] = parts;
  const words = compactTitleWords(titleLower).map((w) => foldArabicForMatch(w));
  return words.includes(stem) && titleLower.includes(digits);
}


/** REEA-721 follow-up — SKU-shaped query intent. Tokens that mix letters and
 *  digits at real length (`ps931cbegww`, `1000xm6`) are the exact part-number
 *  shape a shopper pastes when they want one precise item: every retailer
 *  answer that is NOT that item is filler under such a query. Short model
 *  qualifiers (`s25`, `xm4`) and bare numbers (`17`) carry too little signal
 *  to narrow on — they keep today's relevance path untouched. */
function isCodeShape(token: string): boolean {
  // Letter-led, >=5 chars, carrying a digit: `ps931cbegww`, `mr1qk2` …
  // Digit-led spec words (`128gb`, `1000xm6`) and short qualifiers (`s25`)
  // carry too little identity to be the exact-SKU signal on their own.
  return /^[a-z][a-z0-9]{4,}$/i.test(token) && /\d/.test(token);
}

/** REEA-1154 / REEA-1068 D4 — compact model-family aliases ("fold7",
 *  "iphone17", "pixel9"): a letter run ending in a SHORT digit run, with no
 *  letters after the digits. These clear isCodeShape's >=5-char gate, but they
 *  name a model FAMILY, not one pasted part number. A genuine storefront code
 *  carries a long alphanumeric tail ("ps931cbegww", "uf966ctegww") or mixed
 *  letter/digit runs ("mr1qk2"), so it does not match this shape. The
 *  confidence ladder uses the distinction to keep the REEA-822 exact-SKU
 *  override for part numbers only: treating "fold7" as exact-SKU intent
 *  skipped the accessory demotion, so Fold7 cases/protectors stayed primary
 *  while the spaced spelling ("fold 7") demoted them — one dispatched query
 *  served two different shelves. */
export function isModelAliasShape(token: string): boolean {
  return /^[a-z]+\d{1,3}$/i.test(token);
}

export function skuCodeTokens(query: string): string[] {
  const tokens = queryMatchTokens(query);
  const codes = tokens.filter(isCodeShape);
  if (codes.length === 0) return [];
  // Exact-SKU intent only when EVERYTHING in the query is the code itself:
  // the code tokens, a short attached prefix (`ef`, `a20`), or an Arabic
  // category word riding along. One descriptive word (`sony`, `ipad`) turns
  // this back into a normal model/category query — the plain ladder answers.
  const skuShaped = tokens.every(
    (t) => isCodeShape(t) || t.length <= 3 || /[\u0600-\u06FF]/.test(t),
  );
  return skuShaped ? codes : [];
}

/** True when the title carries the code once separators are folded out on
 *  both sides — the hyphenated storefront spelling "EF-PS931CBEGWW" and the
 *  spaced "EF PS931CBEGWW" meet here. Only >=5-char mixed letter+digit
 *  tokens reach this helper (skuCodeTokens), which keeps a plain substring
 *  safe: rows from another category do not share a code tail that long. */
export function titleCarriesCode(title: string, codes: string[]): boolean {
  const folded = title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, "");
  return codes.some((c) => folded.includes(c));
}

/** Curated Latin spellings of the Arabic-script tokens in a query, in token
 *  order (brand alias value first, then curated category forms). JSON
 *  storefronts whose catalogs are Latin-only answer these spellings while
 *  the Arabic one comes back empty — measured live on pckuwait: `ارز` → a
 *  bare [] from the Store API, `rice` → priced rows. Tokens without an
 *  alias are skipped: the caller's own per-word re-search still covers
 *  them. Purely-Latin queries return []. */
export function latinQueryForms(query: string): string[] {
  const forms: string[] = [];
  for (const t of queryMatchTokens(query)) {
    if (!/[\u0600-\u06FF]/.test(t)) continue;
    // REEA-1218 — the lexicon entry carries the dispatch spelling first and
    // the storefront synonyms after it; brand entries are included so a
    // per-hop re-search can still answer "دوف صابون" with "dove soap".
    const entry = arabicAliasEntryForToken(t);
    if (entry) {
      forms.push(...entry.forms);
      continue;
    }
    const brand = arabicBrandForToken(t);
    if (brand) forms.push(brand.toLowerCase());
  }
  return Array.from(new Set(forms));
}

/** REEA-635 C3 — the dispatch-level LatinBridge: one whole-query Latin
 *  spelling for an Arabic-script (or mixed-script) shopper query. Each Arabic
 *  token is replaced by its curated Latin form (brand alias first, otherwise
 *  the primary curated category form); Latin tokens ride in their original
 *  order. A purely-Latin query comes back untouched.
 *
 *  Measured reality this mirrors: Kuwait storefronts answer Arabic queries
 *  with English-titled rows (REEA-408), and the JSON catalogs are Latin-only
 *  (REEA-550: `دوف صابون` → [] on pckuwait while `dove soap` answers). The
 *  per-hop Latin rounds inside the collectors already ride this map; this
 *  helper lets the SHARED dispatch point lead with the bridged whole-query,
 *  so every adapter hop starts on the spelling the catalog actually carries.
 *  Relevance scoring is unaffected — the caller keeps matching rows against
 *  the shopper's original query. */
export function latinBridgeDispatch(query: string): string {
  // REEA-1218 — phrase-aware: "قدر ضغط" bridges as "pressure cooker" and
  // "الغسالة" bridges through the article-stripped token. The lexicon returns
  // null for purely-Latin queries, so their dispatch is untouched.
  return arabicQueryAlias(query)?.to ?? query;
}

/** True when one query token is answered by the title: substring match on the
 *  alef-folded pair (so "أبل"/"ابل" spellings meet), or — for Arabic-script
 *  brand spellings — the curated Latin form of the brand ("أبل" ⇄ "Apple").
 *  Tokens without an alias behave exactly like the plain substring check.
 *
 *  REEA-416 — the title side also folds LATIN combining marks (é → e, ü → u)
 *  so an ASCII query token meets an accented storefront spelling. The query
 *  tokenizer (queryMatchTokens) already reduces query-side accents to their
 *  ASCII stem; without the title-side fold "NESCAFÉ CLASSIC JAR" scores 0 on
 *  the query "Nescafe coffee" — the gate blanks a column the storefront had
 *  answered, the silent-zero shape measured for Quadra Stores on the deployed
 *  path (HTTP 200, populated payload, empty column). Arabic diacritics stay
 *  handled by normalizeArabicText; the Latin fold is a no-op there. */
export function matchesQueryToken(titleLower: string, token: string): boolean {
  const title = foldArabicForMatch(titleLower)
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "");
  // REEA-1218 — the Arabic token is looked up with the article-stripped
  // variants too, so "الغسالة" answers a "washing machine" title exactly like
  // "غسالة" does.
  for (const key of arabicTokenLookupKeys(token)) {
    if (key !== "" && title.includes(key)) return true;
  }
  // Brand aliases keep precedence; the curated category/family/model forms
  // below only speak for tokens no brand alias claims (REEA-408).
  const entry = arabicAliasEntryForToken(token);
  if (entry) return entry.forms.some((form) => title.includes(form));
  const brand = arabicBrandForToken(token);
  if (brand !== null) return title.includes(brand.toLowerCase());
  return false;
}

/** Query-side brand intent for Arabic-script queries: when the query carries
 *  at least one Arabic-script token AND one token is an alias spelling or the
 *  curated brand itself, return the curated entry. Purely-Latin queries keep
 *  their untouched scoring path; Arabic queries without a brand token return
 *  null and keep current behavior exactly. */
export function arabicBrandIntent(query: string): string | null {
  const tokens = queryMatchTokens(query);
  if (!tokens.some((t) => /[\u0600-\u06FF]/.test(t))) return null;
  for (const t of tokens) {
    // REEA-1218 — article-stripped spellings and the wider fold resolve the
    // panel's brand forms ("ال جي", "آيفون", "سامسونغ") through one lexicon.
    const aliased = arabicBrandForToken(t);
    if (aliased) return aliased;
    const folded = foldArabicForMatch(t);
    for (const entry of CURATED_BRANDS) {
      if (entry.toLowerCase() === folded) return entry;
    }
  }
  return null;
}

/** True when a title carries the query's brand — curated whole-word match on
 *  the Latin form, or one of the brand's Arabic alias spellings. Drives the
 *  brand-match lead ordering only. */
export function titleMatchesBrand(title: string, brand: string): boolean {
  if (curatedBrandInTitle(title) === brand) return true;
  // REEA-1218 — lexicon brands that sit outside the 75-entry curated cap
  // (Nikon, Canon) still lead their own Arabic brand queries through a
  // whole-word Latin check, so "نيكون" ranks Nikon titles like "sony" does.
  if (brand.trim() !== "" && curatedWordRe(brand).test(title)) return true;
  const folded = foldArabicForMatch(normalizedTitle(title));
  for (const [alias, entry] of ARABIC_BRAND_ALIASES) {
    if (entry === brand && folded.includes(alias)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word matcher for one curated entry: hyphens and apostrophes inside
 *  an entry accept their spaced/curly variants; the entry must sit on word
 *  boundaries, so "HP" never fires inside "HPlay". */
function curatedWordRe(entry: string): RegExp {
  const body = escapeRe(entry.toLowerCase())
    .replace(/'/g, "['’]")
    .replace(/-/g, "[\\s/-]*");
  // '-' and '/' are already inside the non-word boundary class.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`, "iu");
}

/* Entries pre-sorted longest first so a more specific brand wins
   ("Head & Shoulders" before a hypothetical shorter word). */
const CURATED_MATCHES = CURATED_BRANDS.map((entry) => ({
  entry,
  re: curatedWordRe(entry),
})).sort((a, b) => b.entry.length - a.entry.length);

/** Case-insensitive whole-word lookup against the curated list, longest entry
 *  first; returns the canonical casing or null.
 *
 *  REA-674 Rule 3 — the scan reads the title's LEADING segment: the
 *  compatibility tail after "for …" (and the Arabic لـ / لل for-prefix) names
 *  the DEVICE an accessory fits, not the brand of what is sold — a Belkin /
 *  Zagg / Araree case "for Apple iPhone" must read its OWN leading brand, and
 *  a produce/candy row under an `apple` query must not inherit Apple from the
 *  tail. With no compatibility phrase the whole title is the segment, so
 *  titles carrying the brand after the model code still resolve. */
export function curatedBrandInTitle(title: string): string | null {
  const lower = normalizedTitle(title).toLowerCase();
  if (!lower) return null;
  const lead = lower.split(/\s+[fF]or\s+|لـ|لل/u)[0] ?? lower;
  const scan = lead.trim() === "" ? lower : lead;
  for (const { entry, re } of CURATED_MATCHES) {
    if (re.test(scan)) return entry;
  }
  return null;
}

/**
 * Rule 1 chain. `brandField` is the retailer's own brand value (may be
 * absent); `title` is the card title. Returns the brand line text, or "" to
 * mean "render the title with no brand line".
 *
 * REEA-487 extends the field branch: a populated field keeps the lead only
 * while it AGREES with the brand the title itself shows. Quadra's Shopify
 * `Manufacturer` option stamps whole import batches with one stale value —
 * a "RAZER HUNTSMAN V3 PRO MINI ..." keyboard and a "STEELSERIES ARCTIS NOVA
 * PRO" headset both arrived carrying `ACER` — and the misbrand then steers
 * brand grouping, brand filters and the named-brand ranking tier. When the
 * field and the title's curated brand disagree, the title-derived brand wins;
 * when they agree the merchant value stays (with curated casing). Titles no
 * curated entry can name keep the old field-first precedence unchanged.
 */
export function resolveBrand(brandField: string | undefined, title: string): string {
  const field = (brandField ?? "").trim();
  if (field !== "") {
    const stop = BRAND_STOP_VALUES.some((s) => s.toLowerCase() === field.toLowerCase());
    if (!stop) {
      // Curated casing of the field itself: SONY/Sony → Sony. Unknown brand
      // values stay exactly as they arrived.
      const lower = field.toLowerCase();
      let curatedField: string | undefined;
      for (const entry of CURATED_BRANDS) {
        if (entry.toLowerCase() === lower) curatedField = entry;
      }
      const titleBrand = curatedBrandInTitle(title);
      if (titleBrand && curatedField !== titleBrand) return titleBrand;
      return curatedField ?? field;
    }
  }
  return curatedBrandInTitle(title) ?? "";
}

/** Rule 2 classification: accessory when the normalized title contains any
 *  EN/AR marker; everything else is device. */
export function isAccessoryTitle(title: string): boolean {
  const lower = normalizedTitle(title).toLowerCase();
  return ACCESSORY_MARKERS.some((m) => lower.includes(m)) || ACCESSORY_WORD_RE.test(lower);
}

/* ---- REEA-592 (REEA-575 spec R1/R3): category gate for the Alternatives
 * row. Nouns are grouped by JOB: titles inside one group replace each other
 * (phones for phones), a title whose only link to the card is brand equality
 * or one shared filler word is off-job noise. Query-side nouns tighten the
 * gate — an Avent soother must not ride a Philips AIRFRYER query on brand
 * equality alone. ---- */
const NOISE_NOUN_RE = /\bcook ?books?\b|\brecipes?\b|\bcookery\b|\bmix(?:es)?\b|\bbook\b/;

const CATEGORY_NOUN_GROUPS: readonly { en: RegExp; ar: readonly string[] }[] = [
  { en: /\biphone\b|\bipad\b|\bsmartphones?\b|\bphones?\b|\btablets?\b/, ar: ["آيفون", "ايفون", "ايباد", "هاتف", "تابلت"] },
  { en: /\bheadphones?\b|\bearphones?\b|\bear ?buds?\b|\bheadsets?\b/, ar: ["سماع"] },
  { en: /\bair ?fryers?\b/, ar: ["قلاية"] },
  { en: /\bcoffee\b/, ar: ["قهوة"] },
  { en: /\bsoothers?\b|\bpacifiers?\b|\bbottles?\b|\bcups?\b|\bmugs?\b/, ar: ["لهاية", "رضاعة", "زجاجة", "كوب"] },
  { en: /\bhangers?\b|\bracks?\b|\bstands?\b|\bholders?\b|\borganizers?\b/, ar: ["حامل", "خزانة", "رف"] },
];

function nounGroupsOf(text: string): Set<number> {
  const found = new Set<number>();
  CATEGORY_NOUN_GROUPS.forEach((group, idx) => {
    if (group.en.test(text) || group.ar.some((word) => text.includes(word))) found.add(idx);
  });
  return found;
}

/** Verdict for one candidate title against the matched card, under the
 *  queried job (spec R1/R3):
 *  "noise" — book/mix-format listing; dropped from BOTH rows;
 *  "offjob" — names a different product class than the queried job; the
 *             mismatch beats brand equality and shared filler tokens;
 *  "comparable" — same job, or no conflicting category noun is named. */
export type AlternativeMatch = "comparable" | "noise" | "offjob";

export function classifyAlternativeMatch(query: string, matchedTitle: string, candidateTitle: string): AlternativeMatch {
  const matched = normalizedTitle(matchedTitle).toLowerCase();
  const candidate = normalizedTitle(candidateTitle).toLowerCase();
  if (NOISE_NOUN_RE.test(candidate)) return "noise";
  const qGroups = nounGroupsOf(normalizedTitle(query).toLowerCase());
  if (qGroups.size === 0) return "comparable";
  const candidateGroups = nounGroupsOf(candidate);
  if (candidateGroups.size === 0) return "comparable";
  const allowed = new Set<number>(qGroups);
  for (const idx of nounGroupsOf(matched)) allowed.add(idx);
  for (const idx of candidateGroups) {
    if (allowed.has(idx)) return "comparable";
  }
  return "offjob";
}

/** Rule 2 gate: device intent when ANY matched title carries a curated brand
 *  or a model-number token. Everything below keeps the current single-list
 *  behavior otherwise. */
export function titleHasDeviceIntent(title: string): boolean {
  return curatedBrandInTitle(title) !== null || MODEL_TOKEN_RE.test(title);
}

/* ---- REEA-213 — Bet 1 relevance-first ranking (REEA-211 brief). ----
 *
 * Four relevance tiers decide the order; price only breaks ties inside a
 * tier. The scorer is pure so the live-results path (collect/live-search.ts)
 * can consume it without duplicating the matching rules. */

/** Trim leading/trailing punctuation from a title word; word-boundary class
 *  mirrors curatedWordRe so digits/letters of any script survive. */
function trimWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{N}\p{L}]+$/gu, "");
}

/** Title → punctuation-trimmed words, whitespace-collapsed. Kept in raw
 *  casing for the model-suffix check; folding happens per comparison. */
function titleWords(title: string): string[] {
  return normalizedTitle(title)
    .split(" ")
    .map(trimWord)
    .filter((w) => w !== "");
}

/** Query tokens in first-seen order, Arabic-folded so "غسّالة" and "غسالة"
 *  meet in one form; the coverage-gate tokenizer supplies the base split. */
export function tierQueryTokens(query: string): string[] {
  const out: string[] = [];
  for (const t of queryMatchTokens(query)) {
    // REEA-1218 — the wider query fold (taa marbuta/ya) so "غسالة" and
    // "غساله" meet the same token; title words are folded the same way below.
    const folded = foldArabicForMatch(t);
    if (folded !== "" && !out.includes(folded)) out.push(folded);
  }
  return out;
}

/** True when one folded title word answers one folded query token: Arabic
 *  tokens match by word-containment (morphology makes exact equality
 *  brittle) with the REEA-195 alias bridge applied per word; Latin tokens
 *  match whole words only, per the brief's matching definition. A
 *  digit-bearing token is a model code, so its separator-folded form must
 *  equal the word's ("fold-7" meets "fold7"; "fold" never meets "Foldable").
 *  The alias check is deliberately word-scoped — a whole-title substring
 *  would let a buried Arabic mention pass the head-position check in tier 1. */
function tokenHitsWord(wordFolded: string, token: string): boolean {
  if (/[\u0600-\u06FF]/.test(token)) {
    if (wordFolded === "") return false;
    const foldedToken = foldArabicForMatch(token);
    if (wordFolded.includes(foldedToken) || foldedToken.includes(wordFolded)) return true;
    // REEA-1218 — the curated Latin forms answer the same intent, so an
    // English-titled row ("LG Washing Machine") still scores against "غسالة".
    const forms = arabicAliasFormsForToken(token);
    if (
      forms.some((form) =>
        form
          .toLowerCase()
          .split(/\s+/)
          .some((formWord) => formWord === wordFolded || form.includes(wordFolded)),
      )
    ) {
      return true;
    }
    const brand = arabicBrandForToken(token);
    if (brand) {
      const lower = brand.toLowerCase();
      if (lower.includes(wordFolded) || wordFolded.includes(lower)) return true;
    }
    return false;
  }
  if (/\d/.test(token)) return foldModelToken(wordFolded) === foldModelToken(token);
  return wordFolded === token;
}

/** How many title words a query phrase may start after and still count as a
 *  head match: 0 by default; one leading brand word is allowed (a word equal
 *  to the card's brand field or a curated brand name). */
function leadingBrandOffset(firstWordFolded: string, metadataFolded: string): number {
  if (firstWordFolded === "") return 0;
  for (const { re } of CURATED_MATCHES) {
    if (re.test(firstWordFolded)) return 1;
  }
  if (metadataFolded !== "" && metadataFolded.includes(firstWordFolded)) return 1;
  return 0;
}

/**
 * Tier the group of one (title, metadata) pair against the query:
 *  1 — every token appears and the phrase sits at the head (position 0 or
 *      immediately after a leading brand word);
 *  2 — full token coverage buried in the title;
 *  3 — at least half the tokens (rounded up) match as whole words;
 *  4 — matched only via brand field / merchant metadata;
 *  0 — zero token matches: ranked below every matched tier (never blended
 *      into the lead block — REEA-222).
 * An empty query treats everything as tier 1 so untouched ordering holds.
 *
 * REEA-1068 — tokens and title words are compared in their compact model form
 * ("fold 7" and "Fold7" both become the token "fold7"), so the spaced spelling
 * of a model no longer collapses into the loose single word "fold" while its
 * compact spelling matches exactly.
 */
function tierOfTokens(
  tokens: readonly string[],
  query: string,
  title: string,
  metadata: string,
): number {
  if (tokens.length === 0) return 1;
  const rawWords = compactTitleWords(title);
  const wordsFolded = rawWords.map((w) => foldArabicForMatch(w));
  const matched = tokens.filter((t) => wordsFolded.some((w) => tokenHitsWord(w, t)));
  if (matched.length === tokens.length) {
    const metadataFolded = foldArabicForMatch(metadata).toLowerCase();
    const offset = leadingBrandOffset(
      rawWords.length > 0 ? foldArabicForMatch(rawWords[0]) : "",
      metadataFolded,
    );
    for (let start = 0; start <= offset; start++) {
      if (start + tokens.length > wordsFolded.length) break;
      if (tokens.every((t, i) => tokenHitsWord(wordsFolded[start + i], t))) return 1;
    }
    return 2;
  }
  // Half the tokens rounded up ⇔ matched * 2 >= tokens.length.
  if (matched.length * 2 >= tokens.length) return 3;
  const metaFolded = foldArabicForMatch(metadata).toLowerCase();
  if (metaFolded !== "" && tokens.some((t) => metaFolded.includes(t))) return 4;
  // REEA-1143 — category-synonym bridge: a category-intent query ("air
  // fryer", "ps5") is answered by a title that names the class product even
  // when the storefront spells the class as one compound word ("Airfryer")
  // or as the platform name ("PlayStation 5") the tokenizer cannot fold into
  // the shopper's token. Only tier 0 is rescued: every higher rung keeps the
  // ladder it earned, so a buried full match stays buried.
  const intent = categoryIntent(query);
  if (intent && categoryRowClass(intent, title) === "product") return 1;
  return 0;
}

export function relevanceTier(query: string, title: string, metadata = ""): number {
  const direct = tierOfTokens(compactQueryTokens(query), query, title, metadata);
  // REEA-1218 — an Arabic query is scored against BOTH the shopper's spelling
  // (Arabic-titled rows) and the curated Latin dispatch spelling (English-
  // titled rows). Taking the better rung keeps Arabic-titled answers ranked as
  // they were while the Latin-titled rows the retailers actually stock stop
  // falling to tier 0 (the Bet 7A empty-primary defect).
  if (!/[\u0600-\u06FF]/.test(query)) return direct;
  const bridged = latinBridgeDispatch(query);
  if (bridged === query) return direct;
  const viaBridge = tierOfTokens(compactQueryTokens(bridged), bridged, title, metadata);
  // A row whose title is Arabic already carries the shopper's own spelling;
  // its direct tier is the honest evidence (a buried Arabic mention stays
  // buried, tier 2). The Latin dispatch spelling only improves a Latin-titled
  // row, where the direct Arabic token scored 0.
  const titleHasArabic = /[\u0600-\u06FF]/.test(title);
  if (direct === 0) return viaBridge;
  if (!titleHasArabic && viaBridge > 0 && viaBridge < direct) return viaBridge;
  return direct;
}

/** Model-suffix qualifiers: short trailing words that extend a model-name
 *  phrase ("iPhone 17 Pro Max") instead of bounding it. */
const MODEL_SUFFIX_RE = /^(max|plus|mini|ultra|lite|neo|turbo|one|pro|gt|xr)$/i;

/**
 * True when, after the matched query phrase, the title continues with another
 * model qualifier — "iPhone 17 Pro Max" under `iPhone 17 Pro`. Only queries
 * that carry a model-number shape (any digit) can extend; a plain category
 * word like "غسالة" has no Max/Mini variants, so every Arabic category match
 * stays non-extended and the brand rule decides the order inside the tier.
 */
export function isModelExtended(query: string, title: string): boolean {
  if (!/\p{Nd}/u.test(query)) return false;
  const tokens = compactQueryTokens(query);
  if (tokens.length === 0) return false;
  const rawWords = compactTitleWords(title);
  const wordsFolded = rawWords.map((w) => foldArabicForMatch(w));
  // Greedy scan to the position of the last token the phrase consumes.
  let k = 0;
  let endAt = -1;
  for (let i = 0; i < wordsFolded.length && k < tokens.length; i++) {
    if (tokenHitsWord(wordsFolded[i], tokens[k])) {
      endAt = i;
      k++;
    }
  }
  if (endAt < 0 || endAt + 1 >= rawWords.length) return false;
  return MODEL_SUFFIX_RE.test(rawWords[endAt + 1]);
}

/** Values that read as "no brand" even though the field is populated. */
const GENERIC_BRAND_RE = /^(non[-\s]?branded|unbranded|generic|no[-\s]?brand|n\/a)$/i;

/**
 * Named-brand signal for inside-tier ordering: a resolved brand that is
 * neither missing, a Rule-1 stop-value, nor a generic placeholder. This is
 * what puts a branded washer ("غسالة فريش 10 كجم", brand Fresh) above the
 * no-name toy card whose brand field is "Non Branded" (accepted tradeoff: a
 * pricier branded card can outrank a cheaper no-name one).
 */
export function brandIsNamed(brandField: string | undefined, title: string): boolean {
  const brand = resolveBrand(brandField, title);
  if (brand === "") return false;
  return !GENERIC_BRAND_RE.test(brand.trim());
}

/* ---- REEA-399 — coverage gate + Arabic generic lane. ---- */

/**
 * REEA-399 — the query-time coverage gate: an answer set "passes" when at
 * least HALF of the retailers in the run contributed at least one hit; below
 * that the query is treated as thinly covered and the generic lane may widen
 * it (see arabicGenericQuery). Same half-rounded-up arithmetic the tier ladder
 * uses (answered * 2 >= total), so one rule governs both card ranking and the
 * widen decision. `answered` counts retailers that contributed hits > 0; a
 * merchant answering with an empty shelf did not COVER the query even though
 * it answered, so it stays on the silent side of the gate. Pure, so the
 * staged collector and the counts probe (scripts/reaa408-counts.mjs) read the
 * gate off the same numbers.
 */
export function queryGatePasses(answered: number, totalRetailers: number): boolean {
  if (totalRetailers <= 0) return false;
  return answered * 2 >= totalRetailers;
}

/**
 * REEA-399 Arabic generic lane: Arabic shopper queries often pair a category
 * word with a brand word ("لابتوب ديل"), and the brand half is exactly what
 * makes thin storefront indexes answer empty while the category alone carries
 * the stock. The generic form drops brand tokens — Arabic aliases from the
 * curated alias map and curated Latin names — keeps the remaining Arabic
 * tokens, and returns "" when nothing generic remains (pure brand query:
 * widening it would only change which brand shows, not coverage). Latin-only
 * queries return "" and keep the untouched enriched path. Deterministic: the
 * same query always folds to the same generic form.
 */
export function arabicGenericQuery(query: string): string {
  const tokens = tierQueryTokens(query); // already alef-folded, first-seen order
  if (!tokens.some((t) => /[\u0600-\u06FF]/.test(t))) return "";
  const generic: string[] = [];
  for (const t of tokens) {
    if (!/[\u0600-\u06FF]/.test(t)) continue; // Latin brand words drop out
    // REEA-1218 — the standalone article is not a word; brand tokens ride
    // along through the alias bridge and are dropped from the generic form.
    if (t === "ال") continue;
    if (arabicBrandForToken(t)) continue; // "ديل" rides along via the alias bridge
    const isCurated = CURATED_BRANDS.some(
      (entry) => foldArabicForMatch(entry).toLowerCase() === t || entry.toLowerCase() === t,
    );
    if (isCurated) continue;
    generic.push(t);
  }
  return generic.join(" ");
}

/** Split a ranked list for device-intent queries: two stacked containers,
 *  Devices above Accessories, each keeping the incoming (arrival/ranking)
 *  order inside it. `tiered: false` means keep the plain single list. */
export function partitionForQuery<T extends { title: string }>(
  products: readonly T[],
): { tiered: boolean; devices: T[]; accessories: T[] } {
  if (!products.some((p) => titleHasDeviceIntent(p.title))) {
    return { tiered: false, devices: [], accessories: [] };
  }
  const devices: T[] = [];
  const accessories: T[] = [];
  for (const p of products) (isAccessoryTitle(p.title) ? accessories : devices).push(p);
  // An all-device or all-accessory list renders identically either way;
  // keep the plain single container when tiering would add nothing.
  if (devices.length === 0 || accessories.length === 0) {
    return { tiered: false, devices: [], accessories: [] };
  }
  return { tiered: true, devices, accessories };
}

/** REEA-793 B1 — device-first serve-time head guard, the narrowSkuLead
 *  pattern applied to the DEVICE/ACCESSORY split of a device-intent query.
 *  Stored snapshots (memo hits, cache-first flushes, KV replays) were ranked
 *  by the chain that wrote them; some predate the device-first ranking, so
 *  an accessory row could lead a device-intent query at read time. This
 *  helper re-heads such a snapshot at SERVE time: rows the caller's
 *  device-row predicate accepts lead, everything else keeps its stored
 *  order behind them. The predicate is injected (not imported) so the guard
 *  stays dependency-light and reusable across call sites. When NO device row
 *  rendered the stored order stands — the pending flag on the served
 *  snapshot carries the honesty state, the list is never re-ranked into a
 *  fake device lead. Pure and idempotent (a stable two-pass partition, same
 *  contract as narrowSkuLead): a snapshot narrowed twice reads identical, so
 *  a memo hit of an already-narrowed snapshot cannot drift. Locale-
 *  independent — the guard reads only the predicate's verdict per row. */
export function narrowDeviceLead<T>(
  query: string,
  products: readonly T[],
  isDeviceRow: (row: T) => boolean,
): T[] {
  if (!titleHasDeviceIntent(query)) return [...products];
  const lead: T[] = [];
  const rest: T[] = [];
  for (const p of products) (isDeviceRow(p) ? lead : rest).push(p);
  if (lead.length === 0) return [...products];
  return [...lead, ...rest];
}

/* ---- REEA-1143 — category-intent ranking class. ----
 *
 * A category-intent query names a product CLASS ("air fryer", "laptop",
 * "headphones", "ps5"), not a specific model. On that surface the shopper is
 * buying the product itself; the complement aisle (liners, cooking spray,
 * cases, chargers, games, food, toys, bags) is what they buy AFTER the
 * product, so it must never lead the shelf. Exact-model queries ("fold 7",
 * "iPhone 17 Pro") keep the untouched ladder: a case can be the correct
 * answer for "fold 7 case", and a model query is about THAT item.
 *
 * The class is derived from the query alone (never a bundled catalogue): a
 * curated class noun matches AND the query carries no model-identity token of
 * its own (modelIdentityTokens). "ps5"/"playStation 5" are platform names,
 * so their compact form counts as the class noun itself. Everything here is
 * pure and locale-independent — EN and AR serve the same order for the same
 * snapshot.
 */
export interface CategoryIntent {
  id: string;
  /** Title regex that names the queried class product (compound spellings
   *  included: "Airfryer" answers "air fryer"). */
  product: RegExp;
  /** Compact spellings that ARE the class noun itself (the model-token
   *  exception: "ps5" is a platform, not a specific model). */
  nouns: readonly string[];
  /** Arabic class nouns on the title side. */
  ar: readonly string[];
}

const CATEGORY_INTENTS: readonly (CategoryIntent & { query: RegExp })[] = [
  {
    id: "air-fryer",
    query: /\bair ?fryers?\b|\bairfryers?\b/i,
    product: /\bair ?fryers?\b|\bairfryers?\b/i,
    nouns: ["airfryer"],
    ar: ["قلاية"],
  },
  {
    id: "laptop",
    query: /\blaptops?\b|\bnotebooks?\b|\bmacbooks?\b/i,
    product: /\blaptops?\b|\bnotebooks?\b|\bmacbooks?\b/i,
    nouns: ["laptop", "notebook", "macbook"],
    ar: ["لابتوب", "حاسوب", "كمبيوتر"],
  },
  {
    id: "headphones",
    // REEA-1218 — AirPods are the storefront spelling of the audio class; a
    // bridged Arabic "سماعة أبل" query must classify an "Apple Airpods" row as
    // the class product, not a neutral row behind an Arabic speaker listing.
    query: /\bheadphones?\b|\bearphones?\b|\bear ?buds?\b|\bheadsets?\b|\bair ?pods?\b/i,
    product: /\bheadphones?\b|\bearphones?\b|\bear ?buds?\b|\bheadsets?\b|\bair ?pods?\b|\bbuds?\b/i,
    nouns: ["headphone", "headphones", "earphone", "earbud", "headset", "airpods"],
    ar: ["سماع", "سماعة", "سماعات"],
  },
  {
    id: "gaming-console",
    query: /\bps ?5\b|\bps5\b|\bplaystation ?5\b/i,
    product: /\bps ?5\b|\bps5\b|\bplaystation ?5\b|\bdualsense\b|\bconsole\b|\bcontroller\b/i,
    nouns: ["ps5", "playstation5"],
    ar: ["بلايستيشن", "يد تحكم"],
  },
  {
    id: "phones-tablets",
    query: /\biphones?\b|\bipads?\b|\bsmartphones?\b|\bphones?\b|\btablets?\b/i,
    product: /\biphones?\b|\bipads?\b|\bsmartphones?\b|\bphones?\b|\btablets?\b/i,
    nouns: ["iphone", "ipad", "smartphone", "phone", "tablet"],
    ar: ["جوال", "هاتف", "ايفون", "آيفون", "ايباد", "تابلت"],
  },
  {
    id: "tv",
    query: /\btelevisions?\b|\bsmart ?tvs?\b|\btvs?\b/i,
    product: /\btelevisions?\b|\bsmart ?tvs?\b|\btvs?\b/i,
    nouns: ["tv", "television", "smarttv"],
    ar: ["تلفاز", "تلفزيون"],
  },
  {
    id: "washing-machine",
    query: /\bwashing machines?\b|\bwashers?\b/i,
    product: /\bwashing machines?\b|\bwashers?\b/i,
    nouns: ["washingmachine", "washer"],
    ar: ["غسالة"],
  },
];

/* The complement aisle of a category query: goods that complement, extend,
 * feed, decorate or entertain the product. Matched as whole words so
 * "Discovery" never fires on "disc"; Arabic rides substring containment like
 * the accessory markers do. Kept in one table so a new complement class is
 * one entry, not a scatter of special cases. */
const CATEGORY_COMPLEMENT_RE =
  // "chips" stays plural-only: a laptop listing's "M4 chip" is hardware, not
  // the snack; "frozen"/"potato" only ever name food. "charging" catches the
  // charging-station accessory class ("Sony PS5 DualSense Charging Station")
  // that the singular "charger" marker misses. "seasoning"/"mix" catch the
  // seasoning sachet that names the class ("Maggi Airfryer Mix Louisiana
  // Buffalo Seasoning") without being the appliance.
  /\b(games?|cartridge|backpacks?|bags?|totes?|pouches?|liners?|papers?|parchment|baking|sprays?|popcorn|chicken|snacks?|food|toys?|play ?sets?|carrying case|cookbooks?|recipes?|books?|chips|frozen|potato(?:es)?|charging|seasonings?|mix(?:es)?)\b/i;
/* "X for PlayStation 5" is the media/software shape (games name the platform
 * as a compatibility suffix), and "disc"/"blu-ray" is the physical media
 * format. A hardware row that ALSO names the platform or a disc drive
 * ("PlayStation 5 Console Disc Edition", "DualSense Controller for PS5") is
 * not media — the hardware noun wins. */
const CATEGORY_MEDIA_RE =
  /\b(discs?|blu-?ray|for (?:playstation|ps ?[345]|xbox|nintendo|switch))\b/i;
const CATEGORY_HARDWARE_RE = /\b(console|controller|dualsense|gamepad|handheld)\b/i;
const CATEGORY_COMPLEMENT_AR = [
  "لعبة", "ألعاب", "لعبه", "حقيبة", "شنطة", "شنط", "ورق", "أكياس", "اكياس",
  "طعام", "وجبة", "وجبات", "كتاب", "بطاطس", "مجمد", "رقائق",
];

/** Query class: a curated category noun with no model identity of its own.
 *  Returns null for exact-model queries ("fold 7", "iPhone 17 Pro"), for
 *  unknown phrases, and for an empty query. Pure and deterministic. */
export function categoryIntent(query: string): CategoryIntent | null {
  // REEA-1218 — an Arabic category word is read through the curated Latin
  // dispatch form ("غسالة" → "washing machine") before the class table, so the
  // existing category intents (laptop/headphones/phones/washing machine) apply
  // to Arabic shoppers instead of returning null. Exact-model Arabic queries
  // keep their model identity below and stay exact-model.
  const q = normalizedTitle(latinBridgeDispatch(query)).toLowerCase();
  if (q === "") return null;
  for (const c of CATEGORY_INTENTS) {
    if (!c.query.test(q)) continue;
    const modelTokens = modelIdentityTokens(query);
    if (modelTokens.length === 0) return c;
    // A model-bearing query inside the class ("iPhone 17 Pro") is an
    // exact-model query — unless the model token IS the class noun ("ps5").
    if (modelTokens.every((t) => c.nouns.includes(t))) return c;
    return null;
  }
  return null;
}

/**
 * REEA-1200 (Bet 7A) — every curated category class a title names. The
 * scope gate needs the title side of the same table `categoryIntent` reads,
 * so a bag under `laptop` is a class conflict (bags ≠ laptop) rather than a
 * loose keyword guess. Pure; the same table, one definition.
 */
export function categoryClassesInTitle(title: string): string[] {
  const lower = normalizedTitle(title).toLowerCase();
  return CATEGORY_INTENTS.filter(
    (c) => c.product.test(lower) || c.ar.some((w) => lower.includes(w)),
  ).map((c) => c.id);
}

/** True when a title names a complement of the queried class (accessory
 *  markers, media/software, food, toys, bags, paper/liners). */
export function isCategoryComplementTitle(title: string): boolean {
  const lower = normalizedTitle(title).toLowerCase();
  if (isAccessoryTitle(title)) return true;
  if (CATEGORY_COMPLEMENT_RE.test(lower)) return true;
  if (CATEGORY_MEDIA_RE.test(lower) && !CATEGORY_HARDWARE_RE.test(lower)) return true;
  return CATEGORY_COMPLEMENT_AR.some((w) => lower.includes(w));
}

/** One row's role under a category intent: the class product itself, a
 *  neutral row (another product / no class signal), or a complement. */
export type CategoryRowClass = "product" | "neutral" | "complement";

export function categoryRowClass(
  intent: CategoryIntent,
  title: string,
): CategoryRowClass {
  const lower = normalizedTitle(title).toLowerCase();
  if (isCategoryComplementTitle(lower)) return "complement";
  if (intent.product.test(lower) || intent.ar.some((w) => lower.includes(w))) {
    return "product";
  }
  return "neutral";
}

/** REEA-1143 — serve-time category head guard, the narrowSkuLead /
 *  narrowDeviceLead pattern applied to the category class. Stored snapshots
 *  (memo hits, stale cache-first flushes, KV replays) were ranked by the chain
 *  that wrote them; some predate this ranking. Re-head such a snapshot at
 *  serve time: class products lead, neutral rows keep their stored order, and
 *  complements trail — never a re-tier, never a fabricated lead (an
 *  accessory-only answer set keeps its stored order). Pure and idempotent (a
 *  stable three-pass partition), locale-independent. Queries without a
 *  category intent pass through unchanged, so exact-model snapshots are
 *  untouched. */
export function narrowCategoryLead<T extends { title: string }>(
  query: string,
  products: readonly T[],
): T[] {
  const intent = categoryIntent(query);
  if (!intent) return [...products];
  const productRows: T[] = [];
  const neutral: T[] = [];
  const complement: T[] = [];
  for (const p of products) {
    const cls = categoryRowClass(intent, p.title);
    (cls === "product" ? productRows : cls === "complement" ? complement : neutral).push(p);
  }
  // No class product in the stored set: the stored order is already the
  // honest answer (accessory-only / empty) — pass it through as-is.
  if (productRows.length === 0) return [...products];
  return [...productRows, ...neutral, ...complement];
}

/** REEA-743 — the exact-SKU head guard re-applied at SERVE time. The fresh
 *  fan-out narrows inside rankByRelevance, but stored snapshots (memo hits,
 *  stale cache-first flushes, shared-layer KV replays) were ranked by the
 *  chain that wrote them — some predating the narrowing, some flushed mid-
 *  round while filler still answered first. This helper closes that gap at
 *  read time: under an exact-SKU query (skuCodeTokens), rows carrying the
 *  code lead and everything else keeps its stored order behind them; when no
 *  row carries the code the stored order stands untouched — an honest zero
 *  reads honestly, it is not re-ranked into a fake one. Queries without the
 *  code shape pass through unchanged. Pure and idempotent (a stable two-pass
 *  partition): the same list narrowed twice reads identical, so a memo hit
 *  of an already-narrowed snapshot cannot drift. Locale-independent — the
 *  guard reads only the query and the titles, so EN and AR serve the same
 *  order for the same snapshot. The family-first gate inside rankByRelevance
 *  stays untouched: this only re-heads a stored list, never re-tiers it. */
export function narrowSkuLead<T extends { title: string }>(
  query: string,
  products: readonly T[],
): T[] {
  // REEA-1154 D4 — the code shape reads the dispatch identity, so every
  // spelling of one dispatched model query narrows the same stored snapshot.
  const codes = skuCodeTokens(dispatchIdentity(query));
  if (codes.length === 0) return [...products];
  const lead: T[] = [];
  const rest: T[] = [];
  for (const p of products) (titleCarriesCode(p.title, codes) ? lead : rest).push(p);
  // No row answers the code: the stored order is already the honest answer
  // (an empty/honest-zero page) — pass it through as-is.
  if (lead.length === 0) return [...products];
  return [...lead, ...rest];
}

/** REEA-822 — the stock-filter keep-predicate for exact-SKU intent. Under a
 *  part-number-shaped query the page is about THAT item (REEA-721/REEA-743):
 *  when every live offer on the matching card is out of stock, dropping the
 *  card under the default showOutOfStock=false view makes the page read an
 *  honest zero for a SKU that EXISTS — the one state the REEA-758 check-1
 *  lead-guard forbids. The matched card must therefore survive the default
 *  card-level drop and render its real out-of-stock state. Returns undefined
 *  for queries without the code shape so the stock filter keeps its plain
 *  REEA-186 contract everywhere else (toggle semantics untouched: non-matched
 *  cards still lose their OOS-only cards and rows, and ?oos=1 still reveals
 *  in place). Locale-independent — reads only the query and the title. */
export function exactSkuKeep(
  query: string,
): ((p: { title: string }) => boolean) | undefined {
  // REEA-1154 D4 — dispatch identity, so the stock keep-predicate agrees with
  // the ranking gate and the confidence partition for every spelling.
  const codes = skuCodeTokens(dispatchIdentity(query));
  if (codes.length === 0) return undefined;
  return (p) => titleCarriesCode(p.title, codes);
}
