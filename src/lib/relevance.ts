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
   normalized lowercase title. */
const ACCESSORY_MARKERS: readonly string[] = [
  "case", "cover", "protector", "tempered glass", "film", "skin",
  "adapter", "adaptor", "charger", "dock", "holder", "hanger", "rack",
  "eartips", "ear tips", "sleeve",
  "كفر", "جراب", "واقي", "غطاء", "شاحن", "كابل", "وصلة", "حامل",
];

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

/** Arabic-script spellings of curated brands as the Kuwait storefronts carry
 *  them. Keys are compared after normalizeArabicText(), so hamza variants share
 *  one entry. Used ONLY to match an Arabic query against retailer titles and
 *  to rank brand-intent queries — brand LINES still come from resolveBrand's
 *  Rule-1 chain, so an unbranded item never inherits a brand from its title's
 *  alias spelling. */
const ARABIC_BRAND_ALIASES: ReadonlyMap<string, string> = new Map([
  ["ابل", "Apple"],
  ["ايفون", "Apple"],
  ["سامسونج", "Samsung"],
  ["سامسونغ", "Samsung"],
  ["سوني", "Sony"],
  ["بوز", "Bose"],
  ["شاومي", "Xiaomi"],
  ["هواوي", "Huawei"],
  ["هونر", "Honor"],
  ["اوبو", "Oppo"],
  ["فيفو", "Vivo"],
  ["ريلمي", "Realme"],
  ["جوجل", "Google"],
  ["مايكروسوفت", "Microsoft"],
  ["ديل", "Dell"],
  ["لينوفو", "Lenovo"],
  ["اسوس", "Asus"],
  ["ايسر", "Acer"],
  ["ال جي", "LG"],
  ["توشيبا", "Toshiba"],
  ["فيليبس", "Philips"],
  ["باناسونيك", "Panasonic"],
  ["هايسنس", "Hisense"],
  ["شارب", "Sharp"],
  ["دايسون", "Dyson"],
  ["دوف", "Dove"],
  ["المراعي", "Almarai"],
  ["الصافي", "Al Safi"],
]);

/** Curated Arabic category words and the Latin spellings the storefronts
 *  actually carry (REEA-408). Kuwait zones answer Arabic-category queries
 *  with English-titled rows — measured live 2026-09-09: Sultan Center
 *  answers `أرز بسمتي` with priced rows titled "Country Xl Organic Basmati
 *  Rice" &co — and a cross-script substring check scores every one of them
 *  0, which is the silent-zero shape the fixed-query matrix kept hitting.
 *  The REEA-399 generic lane keeps zero-score answers alive only while the
 *  query carries no brand token, so brand+category queries like
 *  `لابتوب ديل` still lost their real matches: a "Latitude 5440 Laptop"
 *  row answers neither the Latin form of ديل nor a bare Arabic token.
 *  This map gives the common category words their curated Latin form, so
 *  the coverage gate scores the row instead of dropping it. Same
 *  convention as ARABIC_BRAND_ALIASES: keys are compared after
 *  normalizeArabicText(); unknown tokens keep the plain substring path. */
const ARABIC_QUERY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["ارز", ["rice"]],
  ["بسمتي", ["basmati"]],
  ["صابون", ["soap"]],
  ["كيبورد", ["keyboard"]],
  ["لابتوب", ["laptop", "notebook"]],
  ["جوال", ["smartphone", "mobile phone"]],
  ["سماعة", ["headphone", "headset", "earbud"]],
  ["تلفاز", ["television", "smart tv"]],
  ["ثلاجة", ["fridge", "refrigerator"]],
  ["غسالة", ["washing machine", "washer"]],
  ["مكيف", ["air conditioner"]],
  ["شاشة", ["monitor", "screen"]],
]);

/** Fold the alef family + case so alias keys and storefront spellings meet in
 *  one form ("أبل"/"ابل"/"آبل" all normalize to the same shape). REEA-213:
 *  tashkeel and tatweel are stripped first so a vowelled spelling ("غسّالة")
 *  and the plain one ("غسالة") compare equal — diacritics must not change a
 *  shopper's results (REEA-211 brief, definition of normalization). */
export function normalizeArabicText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u0640\u064B-\u065F\u0670]/g, "") // tatweel + tashkeel
    .replace(/[\u0621\u0622\u0623\u0625\u0627\u0671]/g, "ا")
    .trim();
}

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
    const folded = normalizeArabicText(t);
    const brand = ARABIC_BRAND_ALIASES.get(folded);
    if (brand !== undefined) {
      forms.push(brand.toLowerCase());
      continue;
    }
    const cats = ARABIC_QUERY_ALIASES.get(folded);
    if (cats !== undefined) forms.push(...cats);
  }
  return Array.from(new Set(forms));
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
  const title = normalizeArabicText(titleLower)
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "");
  const folded = normalizeArabicText(token);
  if (folded !== "" && title.includes(folded)) return true;
  // Brand aliases keep precedence; the curated category forms below only
  // speak for tokens no brand alias claims (REEA-408).
  const entry = ARABIC_BRAND_ALIASES.get(folded);
  if (entry !== undefined) return title.includes(entry.toLowerCase());
  const forms = ARABIC_QUERY_ALIASES.get(folded);
  if (forms !== undefined) return forms.some((form) => title.includes(form));
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
    const aliased = ARABIC_BRAND_ALIASES.get(normalizeArabicText(t));
    if (aliased) return aliased;
    for (const entry of CURATED_BRANDS) {
      if (entry.toLowerCase() === t) return entry;
    }
  }
  return null;
}

/** True when a title carries the query's brand — curated whole-word match on
 *  the Latin form, or one of the brand's Arabic alias spellings. Drives the
 *  brand-match lead ordering only. */
export function titleMatchesBrand(title: string, brand: string): boolean {
  if (curatedBrandInTitle(title) === brand) return true;
  const folded = normalizeArabicText(normalizedTitle(title));
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

/** Case-insensitive whole-word title lookup against the curated list, longest
 *  entry first; returns the canonical casing or null. */
export function curatedBrandInTitle(title: string): string | null {
  const lower = normalizedTitle(title).toLowerCase();
  if (!lower) return null;
  for (const { entry, re } of CURATED_MATCHES) {
    if (re.test(lower)) return entry;
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
  return ACCESSORY_MARKERS.some((m) => lower.includes(m));
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
    const folded = normalizeArabicText(t);
    if (folded !== "" && !out.includes(folded)) out.push(folded);
  }
  return out;
}

/** True when one folded title word answers one folded query token: Arabic
 *  tokens match by word-containment (morphology makes exact equality
 *  brittle) with the REEA-195 alias bridge applied per word; Latin tokens
 *  match whole words only, per the brief's matching definition. The alias
 *  check is deliberately word-scoped — a whole-title substring would let a
 *  buried Arabic mention pass the head-position check in tier 1. */
function tokenHitsWord(wordFolded: string, token: string): boolean {
  if (/[\u0600-\u06FF]/.test(token)) {
    if (wordFolded === "") return false;
    if (wordFolded.includes(token) || token.includes(wordFolded)) return true;
    const entry = ARABIC_BRAND_ALIASES.get(token);
    return entry !== undefined && entry.toLowerCase().includes(wordFolded);
  }
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
 */
export function relevanceTier(query: string, title: string, metadata = ""): number {
  const tokens = tierQueryTokens(query);
  if (tokens.length === 0) return 1;
  const wordsFolded = titleWords(title).map((w) => normalizeArabicText(w));
  const matched = tokens.filter((t) => wordsFolded.some((w) => tokenHitsWord(w, t)));
  if (matched.length === tokens.length) {
    const rawWords = titleWords(title);
    const metadataFolded = normalizeArabicText(metadata).toLowerCase();
    const offset = leadingBrandOffset(
      rawWords.length > 0 ? normalizeArabicText(rawWords[0]) : "",
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
  const metaFolded = normalizeArabicText(metadata).toLowerCase();
  if (metaFolded !== "" && tokens.some((t) => metaFolded.includes(t))) return 4;
  return 0;
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
  const tokens = tierQueryTokens(query);
  if (tokens.length === 0) return false;
  const rawWords = titleWords(title);
  const wordsFolded = rawWords.map((w) => normalizeArabicText(w));
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
    if (ARABIC_BRAND_ALIASES.has(t)) continue; // "ديل" rides along via the alias bridge
    const isCurated = CURATED_BRANDS.some(
      (entry) => normalizeArabicText(entry).toLowerCase() === t || entry.toLowerCase() === t,
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
