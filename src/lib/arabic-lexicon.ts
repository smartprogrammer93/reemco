/**
 * REEA-1218 (Bet 8) — the static AR↔EN retail lexicon and Arabic query
 * normalization used by the live results path.
 *
 * Why this module exists: Kuwait shoppers search in Arabic, while the
 * retailers' search indexes and most of their titles are Latin. The existing
 * Arabic bridge in lib/relevance.ts only knew a handful of category words, and
 * the Bet 7A relevance/scope gate (lib/scope-gate.ts) classified every
 * Latin-titled row under an Arabic query as "accessory"/"consumable" because it
 * could not read the Arabic token. The result was an empty primary shelf for
 * ordinary queries like غسالة / ثلاجة / لابتوب while the English equivalent
 * returned a full shelf.
 *
 * This module is deliberately data-only and browser-safe: no I/O, no React, no
 * retailer fetch. It is a curated, hand-written map (no machine translation),
 * shipped as a static asset — AC-7: no per-query or per-user storage.
 *
 * Matching normalization (the ticket's scope item 2):
 *  - alef variants (أ/إ/آ/ا) fold to ا;
 *  - taa marbuta (ة) folds to ه;
 *  - ya (ى) folds to ي;
 *  - tashkeel/tatweel are stripped;
 *  - the definite article ال is tried with and without when looking a token up.
 *
 * The lexicon is intentionally small and curated: it covers the common Kuwaiti
 * categories and brands the four retailers actually carry. Unknown Arabic
 * tokens keep their plain path.
 */

export type ArabicAliasKind = "brand" | "category" | "family" | "model";

export interface ArabicAliasEntry {
  kind: ArabicAliasKind;
  /** Arabic spellings as shoppers type them (hamza/alef/taa variants included
   *  where the panel measured them). */
  arabic: readonly string[];
  /** The Latin spelling retailer indexes/catalogs actually answer. */
  latin: string;
  /** Latin forms that answer the same intent for title matching. The first
   *  form is normally the dispatch spelling; the rest are synonyms the
   *  storefronts use (e.g. fridge/refrigerator). */
  forms: readonly string[];
  /** Canonical curated brand name for brand entries (and model+brand pairs
   *  such as ايفون → Apple). */
  brand?: string;
}

/** Fold the alef family, taa marbuta, ya and diacritics into one comparison
 *  form. Kept separate from `normalizeArabicText` so existing callers that
 *  rely on the pre-REEA-1218 fold (title identity, canonical tuples) keep
 *  their exact behaviour; Arabic query matching opts into the wider fold. */
export function foldArabicForMatch(text: string): string {
  return normalizeArabicText(text)
    .replace(/\u0629/g, "ه")
    .replace(/\u0649/g, "ي")
    .replace(/\u0624/g, "و")
    .replace(/\u0626/g, "ي");
}

/** The historical Arabic fold (REEA-213): lower-case, strip tatweel/tashkeel,
 *  fold the alef family. Exported unchanged because other modules depend on
 *  its exact shape. */
export function normalizeArabicText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u0640\u064B-\u065F\u0670]/g, "")
    .replace(/[\u0621\u0622\u0623\u0625\u0627\u0671]/g, "ا")
    .trim();
}

/** Lookup keys for one Arabic token: the folded form, and the folded form
 *  without a leading definite article when that leaves a real word. */
export function arabicTokenLookupKeys(token: string): string[] {
  const folded = foldArabicForMatch(token);
  const keys = [folded];
  const stripped = folded.replace(/^ال/, "");
  if (stripped !== folded && stripped.length >= 2) keys.push(stripped);
  return keys;
}

/** Phrase lookup key: every token is folded, and a token's article-stripped
 *  form is used when it still carries a word. "الغسالة" → "غساله"; "ال جي"
 *  keeps its two-token phrase key because "ال" alone has nothing left. */
function phraseLookupKey(phrase: string): string {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const keys = arabicTokenLookupKeys(token);
      return keys.length > 1 ? keys[1] : keys[0];
    })
    .join(" ");
}

/* ---------------------------------------------------------------------------
 * The curated lexicon. Entries are grouped by the shopper's intent so a
 * reviewer can see the coverage the panel exercises. Keep this list
 * hand-curated; do not generate it from product titles at request time.
 * ------------------------------------------------------------------------- */

const ENTRIES: readonly ArabicAliasEntry[] = [
  /* ---- Home appliances ---- */
  {
    kind: "category",
    arabic: ["غسالة", "غساله", "غسالة ملابس", "غساله ملابس"],
    latin: "washing machine",
    forms: ["washing machine", "washer", "washing machines"],
  },
  {
    kind: "category",
    arabic: ["ثلاجة", "ثلاجه", "براد", "ثلاجة تبريد"],
    latin: "fridge",
    forms: ["fridge", "refrigerator", "refrigerators", "fridges"],
  },
  {
    kind: "category",
    arabic: ["مكيف", "مكيفات", "تكييف", "مكيف هواء"],
    latin: "air conditioner",
    forms: ["air conditioner", "air conditioning", "air conditioners"],
  },
  {
    kind: "category",
    arabic: ["مكنسة", "مكنسه", "مكانس", "مكنسة كهربائية"],
    latin: "vacuum cleaner",
    forms: ["vacuum cleaner", "vacuum", "vacuum cleaners", "hoover"],
  },
  {
    kind: "category",
    arabic: ["قدر ضغط", "قدر الضغط", "طنجرة ضغط"],
    latin: "pressure cooker",
    forms: ["pressure cooker", "pressure cookers"],
  },
  {
    kind: "category",
    arabic: ["غسالة صحون", "غساله صحون", "جلاية"],
    latin: "dishwasher",
    forms: ["dishwasher", "dishwashers"],
  },
  {
    kind: "category",
    arabic: ["ميكروويف", "مايكروويف"],
    latin: "microwave",
    forms: ["microwave", "microwaves"],
  },
  {
    kind: "category",
    arabic: ["فرن", "فرن كهربائي"],
    latin: "oven",
    forms: ["oven", "ovens", "electric oven"],
  },
  {
    kind: "category",
    arabic: ["غلاية", "غلايه", "غلاية ماء"],
    latin: "kettle",
    forms: ["kettle", "electric kettle"],
  },
  {
    kind: "category",
    arabic: ["مروحة", "مروحه"],
    latin: "fan",
    forms: ["fan", "fans", "electric fan"],
  },
  {
    kind: "category",
    arabic: ["سخان", "سخان ماء"],
    latin: "water heater",
    forms: ["water heater", "heater", "geyser"],
  },
  {
    kind: "category",
    arabic: ["مكواة", "مكواه", "مكواة بخار"],
    latin: "steam iron",
    forms: ["steam iron", "iron", "clothes iron"],
  },

  /* ---- Mobiles / computing / audio ---- */
  {
    kind: "category",
    arabic: ["جوال", "جوالات", "هاتف", "هواتف", "موبايل", "تلفون"],
    latin: "smartphone",
    forms: ["smartphone", "smartphones", "mobile phone", "phone", "phones"],
  },
  {
    kind: "category",
    arabic: ["لابتوب", "لابتوبات", "حاسوب", "كمبيوتر", "كمبيوتر محمول"],
    latin: "laptop",
    forms: ["laptop", "laptops", "notebook", "notebooks", "macbook"],
  },
  {
    kind: "category",
    arabic: ["سماعة", "سماعة رأس"],
    latin: "headphone",
    forms: ["headphone", "headset", "earbud"],
  },
  {
    kind: "category",
    arabic: ["سماعات", "سماعات رأس", "إيربودز", "ايربودز"],
    latin: "headphones",
    forms: ["headphones", "headphone", "earbuds", "earphone", "headset"],
  },
  {
    kind: "category",
    arabic: ["تلفاز", "تلفزيون", "تلفزيونات", "شاشة تلفزيون"],
    latin: "television",
    forms: ["television", "tv", "smart tv"],
  },
  {
    kind: "category",
    arabic: ["شاشة", "شاشه", "شاشات"],
    latin: "monitor",
    forms: ["monitor", "monitors", "screen"],
  },
  {
    kind: "category",
    arabic: ["كيبورد", "لوحة مفاتيح"],
    latin: "keyboard",
    forms: ["keyboard"],
  },
  {
    kind: "category",
    arabic: ["ماوس", "فأرة"],
    latin: "mouse",
    forms: ["mouse", "mice"],
  },
  {
    kind: "category",
    arabic: ["طابعة", "طابعه"],
    latin: "printer",
    forms: ["printer", "printers"],
  },
  {
    kind: "category",
    arabic: ["راوتر", "موزع شبكة"],
    latin: "router",
    forms: ["router", "routers"],
  },
  {
    kind: "category",
    arabic: ["كاميرا", "كاميرات"],
    latin: "camera",
    forms: ["camera", "cameras", "digital camera"],
  },
  {
    kind: "category",
    arabic: ["ساعة ذكية", "ساعات ذكية"],
    latin: "smartwatch",
    forms: ["smartwatch", "smart watch", "watch"],
  },
  {
    kind: "category",
    arabic: ["بلايستيشن", "بلاي ستيشن"],
    latin: "playstation",
    forms: ["playstation", "ps5", "ps4", "console"],
  },
  {
    kind: "category",
    arabic: ["اكس بوكس", "إكس بوكس"],
    latin: "xbox",
    forms: ["xbox", "console"],
  },
  {
    kind: "category",
    arabic: ["نينتندو سويتش", "سويتش"],
    latin: "nintendo switch",
    forms: ["nintendo switch", "switch"],
  },

  /* ---- Groceries / pharmacy / household ---- */
  { kind: "category", arabic: ["ارز", "أرز"], latin: "rice", forms: ["rice"] },
  { kind: "category", arabic: ["بسمتي"], latin: "basmati", forms: ["basmati"] },
  { kind: "category", arabic: ["صابون"], latin: "soap", forms: ["soap"] },
  { kind: "category", arabic: ["حليب"], latin: "milk", forms: ["milk"] },
  { kind: "category", arabic: ["قهوة", "قهوه"], latin: "coffee", forms: ["coffee"] },
  { kind: "category", arabic: ["شاي"], latin: "tea", forms: ["tea"] },
  { kind: "category", arabic: ["ماء", "مياه"], latin: "water", forms: ["water", "mineral water"] },
  { kind: "category", arabic: ["سكر"], latin: "sugar", forms: ["sugar"] },
  { kind: "category", arabic: ["دقيق", "طحين"], latin: "flour", forms: ["flour"] },
  { kind: "category", arabic: ["زيت", "زيت طبخ"], latin: "cooking oil", forms: ["cooking oil", "oil"] },
  { kind: "category", arabic: ["تمر", "تمور"], latin: "dates", forms: ["dates", "date"] },
  { kind: "category", arabic: ["عسل"], latin: "honey", forms: ["honey"] },
  { kind: "category", arabic: ["جبن", "جبنة", "جبنه"], latin: "cheese", forms: ["cheese"] },
  { kind: "category", arabic: ["زبادي", "زبادي طبيعي"], latin: "yogurt", forms: ["yogurt", "yoghurt"] },
  { kind: "category", arabic: ["بيض"], latin: "eggs", forms: ["eggs", "egg"] },
  { kind: "category", arabic: ["خبز"], latin: "bread", forms: ["bread"] },
  { kind: "category", arabic: ["دجاج"], latin: "chicken", forms: ["chicken"] },
  { kind: "category", arabic: ["لحم", "لحوم"], latin: "meat", forms: ["meat", "beef", "lamb"] },
  { kind: "category", arabic: ["سمك", "أسماك"], latin: "fish", forms: ["fish", "seafood"] },
  { kind: "category", arabic: ["بطاطس", "بطاطا"], latin: "potato", forms: ["potato", "potatoes"] },
  { kind: "category", arabic: ["طماطم", "بندورة"], latin: "tomato", forms: ["tomato", "tomatoes"] },
  { kind: "category", arabic: ["خيار"], latin: "cucumber", forms: ["cucumber", "cucumbers"] },
  { kind: "category", arabic: ["بصل"], latin: "onion", forms: ["onion", "onions"] },
  { kind: "category", arabic: ["جزر"], latin: "carrot", forms: ["carrot", "carrots"] },
  { kind: "category", arabic: ["تفاح"], latin: "apple", forms: ["apple", "apples"] },
  { kind: "category", arabic: ["موز"], latin: "banana", forms: ["banana", "bananas"] },
  { kind: "category", arabic: ["برتقال"], latin: "orange", forms: ["orange", "oranges"] },
  { kind: "category", arabic: ["ليمون"], latin: "lemon", forms: ["lemon", "lemons"] },
  { kind: "category", arabic: ["فراولة", "فراوله"], latin: "strawberry", forms: ["strawberry", "strawberries"] },
  { kind: "category", arabic: ["بطيخ"], latin: "watermelon", forms: ["watermelon"] },
  { kind: "category", arabic: ["عنب"], latin: "grapes", forms: ["grapes", "grape"] },
  { kind: "category", arabic: ["مانجو"], latin: "mango", forms: ["mango", "mangoes"] },
  { kind: "category", arabic: ["زيتون"], latin: "olives", forms: ["olives", "olive"] },
  { kind: "category", arabic: ["تونة", "تونة معلبة"], latin: "tuna", forms: ["tuna"] },
  { kind: "category", arabic: ["شوكولاتة", "شوكولاته"], latin: "chocolate", forms: ["chocolate", "chocolates"] },
  { kind: "category", arabic: ["بسكويت"], latin: "biscuits", forms: ["biscuits", "biscuit", "cookies"] },
  { kind: "category", arabic: ["حفاضات", "حفاظات"], latin: "diapers", forms: ["diapers", "nappies"] },
  { kind: "category", arabic: ["مناديل"], latin: "tissues", forms: ["tissues", "tissue"] },
  { kind: "category", arabic: ["شامبو"], latin: "shampoo", forms: ["shampoo"] },
  { kind: "category", arabic: ["معجون أسنان", "معجون"], latin: "toothpaste", forms: ["toothpaste"] },
  { kind: "category", arabic: ["منظف", "منظفات"], latin: "cleaner", forms: ["cleaner", "detergent", "cleaners"] },
  { kind: "category", arabic: ["مبيد حشرات", "مبيد"], latin: "insecticide", forms: ["insecticide", "pesticide"] },
  { kind: "category", arabic: ["فيتامين", "فيتامينات"], latin: "vitamin", forms: ["vitamin", "vitamins", "supplement"] },
  {
    kind: "family",
    arabic: ["بانادول", "بنادول", "بانادول اكسترا", "بنادول اكسترا"],
    latin: "panadol",
    forms: ["panadol", "panadrex", "paracetamol"],
  },

  /* ---- Brands (Arabic spellings the Kuwait storefronts use) ---- */
  { kind: "brand", arabic: ["ابل", "أبل"], latin: "apple", forms: ["apple"], brand: "Apple" },
  { kind: "model", arabic: ["ايفون", "آيفون", "أيفون"], latin: "iphone", forms: ["iphone", "apple"], brand: "Apple" },
  { kind: "model", arabic: ["ايباد", "آيباد"], latin: "ipad", forms: ["ipad", "apple"], brand: "Apple" },
  { kind: "model", arabic: ["جالاكسي", "جالكسي"], latin: "galaxy", forms: ["galaxy", "samsung"], brand: "Samsung" },
  { kind: "model", arabic: ["فولد"], latin: "fold", forms: ["fold"] },
  { kind: "model", arabic: ["برو"], latin: "pro", forms: ["pro"] },
  { kind: "model", arabic: ["نوت"], latin: "note", forms: ["note"] },
  { kind: "model", arabic: ["بنادول", "بانادول"], latin: "panadol", forms: ["panadol"] },
  { kind: "brand", arabic: ["سامسونج", "سامسونغ", "سامسونق"], latin: "samsung", forms: ["samsung"], brand: "Samsung" },
  { kind: "brand", arabic: ["سوني"], latin: "sony", forms: ["sony"], brand: "Sony" },
  { kind: "brand", arabic: ["ال جي", "إل جي", "جي"], latin: "lg", forms: ["lg"], brand: "LG" },
  { kind: "brand", arabic: ["نيكون"], latin: "nikon", forms: ["nikon"], brand: "Nikon" },
  { kind: "brand", arabic: ["كانون"], latin: "canon", forms: ["canon"], brand: "Canon" },
  { kind: "brand", arabic: ["بوز"], latin: "bose", forms: ["bose"], brand: "Bose" },
  { kind: "brand", arabic: ["شاومي"], latin: "xiaomi", forms: ["xiaomi", "mi"], brand: "Xiaomi" },
  { kind: "brand", arabic: ["هواوي"], latin: "huawei", forms: ["huawei"], brand: "Huawei" },
  { kind: "brand", arabic: ["هونر"], latin: "honor", forms: ["honor"], brand: "Honor" },
  { kind: "brand", arabic: ["اوبو", "أوبو"], latin: "oppo", forms: ["oppo"], brand: "Oppo" },
  { kind: "brand", arabic: ["فيفو"], latin: "vivo", forms: ["vivo"], brand: "Vivo" },
  { kind: "brand", arabic: ["ريلمي"], latin: "realme", forms: ["realme"], brand: "Realme" },
  { kind: "brand", arabic: ["نوثينج"], latin: "nothing", forms: ["nothing"], brand: "Nothing" },
  { kind: "brand", arabic: ["جوجل"], latin: "google", forms: ["google", "pixel"], brand: "Google" },
  { kind: "brand", arabic: ["مايكروسوفت"], latin: "microsoft", forms: ["microsoft", "surface"], brand: "Microsoft" },
  { kind: "brand", arabic: ["ديل"], latin: "dell", forms: ["dell"], brand: "Dell" },
  { kind: "brand", arabic: ["لينوفو"], latin: "lenovo", forms: ["lenovo"], brand: "Lenovo" },
  { kind: "brand", arabic: ["اتش بي", "إتش بي", "اتشبي"], latin: "hp", forms: ["hp"], brand: "HP" },
  { kind: "brand", arabic: ["اسوس", "أسوس"], latin: "asus", forms: ["asus"], brand: "Asus" },
  { kind: "brand", arabic: ["ايسر", "أيسر"], latin: "acer", forms: ["acer"], brand: "Acer" },
  { kind: "brand", arabic: ["توشيبا"], latin: "toshiba", forms: ["toshiba"], brand: "Toshiba" },
  { kind: "brand", arabic: ["فيليبس"], latin: "philips", forms: ["philips"], brand: "Philips" },
  { kind: "brand", arabic: ["باناسونيك"], latin: "panasonic", forms: ["panasonic"], brand: "Panasonic" },
  { kind: "brand", arabic: ["هايسنس"], latin: "hisense", forms: ["hisense"], brand: "Hisense" },
  { kind: "brand", arabic: ["تي سي ال", "تي سي إل"], latin: "tcl", forms: ["tcl"], brand: "TCL" },
  { kind: "brand", arabic: ["شارب"], latin: "sharp", forms: ["sharp"], brand: "Sharp" },
  { kind: "brand", arabic: ["دايسون"], latin: "dyson", forms: ["dyson"], brand: "Dyson" },
  { kind: "brand", arabic: ["براون"], latin: "braun", forms: ["braun"], brand: "Braun" },
  { kind: "brand", arabic: ["ديلونجي"], latin: "delonghi", forms: ["delonghi"], brand: "DeLonghi" },
  { kind: "brand", arabic: ["نسبرسو"], latin: "nespresso", forms: ["nespresso"], brand: "Nespresso" },
  { kind: "brand", arabic: ["تيفال"], latin: "tefal", forms: ["tefal"], brand: "Tefal" },
  { kind: "brand", arabic: ["كينوود"], latin: "kenwood", forms: ["kenwood"], brand: "Kenwood" },
  { kind: "brand", arabic: ["اليكترولوكس", "إلكترولوكس"], latin: "electrolux", forms: ["electrolux"], brand: "Electrolux" },
  { kind: "brand", arabic: ["جيه بي ال", "جي بي ال"], latin: "jbl", forms: ["jbl"], brand: "JBL" },
  { kind: "brand", arabic: ["سينهايزر"], latin: "sennheiser", forms: ["sennheiser"], brand: "Sennheiser" },
  { kind: "brand", arabic: ["انكر", "أنكر"], latin: "anker", forms: ["anker"], brand: "Anker" },
  { kind: "brand", arabic: ["ريزر"], latin: "razer", forms: ["razer"], brand: "Razer" },
  { kind: "brand", arabic: ["ستيل سيريز"], latin: "steelseries", forms: ["steelseries"], brand: "SteelSeries" },
  { kind: "brand", arabic: ["لوجيتك"], latin: "logitech", forms: ["logitech"], brand: "Logitech" },
  { kind: "brand", arabic: ["كورسير"], latin: "corsair", forms: ["corsair"], brand: "Corsair" },
  { kind: "brand", arabic: ["دوف"], latin: "dove", forms: ["dove"], brand: "Dove" },
  { kind: "brand", arabic: ["المراعي", "مراعي"], latin: "almarai", forms: ["almarai"], brand: "Almarai" },
  { kind: "brand", arabic: ["الصافي", "صافي"], latin: "al safi", forms: ["al safi"], brand: "Al Safi" },
  { kind: "brand", arabic: ["لوكس"], latin: "lux", forms: ["lux"], brand: "Lux" },
  { kind: "brand", arabic: ["جليت", "جيلت"], latin: "gillette", forms: ["gillette"], brand: "Gillette" },
  { kind: "brand", arabic: ["بامبرز"], latin: "pampers", forms: ["pampers"], brand: "Pampers" },
  { kind: "brand", arabic: ["هجيز"], latin: "huggies", forms: ["huggies"], brand: "Huggies" },
  { kind: "brand", arabic: ["اريال", "أريال"], latin: "ariel", forms: ["ariel"], brand: "Ariel" },
  { kind: "brand", arabic: ["اومو", "أومو"], latin: "omo", forms: ["omo"], brand: "Omo" },
  { kind: "brand", arabic: ["فيري"], latin: "fairy", forms: ["fairy"], brand: "Fairy" },
  { kind: "brand", arabic: ["سيف"], latin: "cif", forms: ["cif"], brand: "Cif" },
  { kind: "brand", arabic: ["نسكافيه"], latin: "nescafe", forms: ["nescafe"], brand: "Nescafe" },
  { kind: "brand", arabic: ["ليبتون"], latin: "lipton", forms: ["lipton"], brand: "Lipton" },
  { kind: "brand", arabic: ["نستله"], latin: "nestle", forms: ["nestle"], brand: "Nestle" },
  { kind: "brand", arabic: ["كوكاكولا", "كوكا كولا"], latin: "coca-cola", forms: ["coca-cola", "coke"], brand: "Coca-Cola" },
  { kind: "brand", arabic: ["بيبسي"], latin: "pepsi", forms: ["pepsi"], brand: "Pepsi" },
];

const TOKEN_ALIASES = new Map<string, ArabicAliasEntry>();
const PHRASE_ALIASES = new Map<string, ArabicAliasEntry>();
const BRAND_ALIASES = new Map<string, string>();
const MODEL_ALIASES = new Map<string, string>();
const QUERY_ALIASES = new Map<string, readonly string[]>();
const FAMILY_ALIASES = new Map<string, readonly string[]>();

for (const entry of ENTRIES) {
  for (const spelling of entry.arabic) {
    const isPhrase = /\s/.test(spelling.trim());
    if (isPhrase) {
      PHRASE_ALIASES.set(phraseLookupKey(spelling), entry);
    } else {
      for (const key of arabicTokenLookupKeys(spelling)) TOKEN_ALIASES.set(key, entry);
    }
  }
  if (entry.brand) {
    for (const spelling of entry.arabic) {
      const isPhrase = /\s/.test(spelling.trim());
      const keys = isPhrase ? [phraseLookupKey(spelling)] : arabicTokenLookupKeys(spelling);
      for (const key of keys) BRAND_ALIASES.set(key, entry.brand);
    }
  }
  if (entry.kind === "model") {
    for (const spelling of entry.arabic) {
      const isPhrase = /\s/.test(spelling.trim());
      const keys = isPhrase ? [phraseLookupKey(spelling)] : arabicTokenLookupKeys(spelling);
      for (const key of keys) MODEL_ALIASES.set(key, entry.latin);
    }
  }
  if (entry.kind === "family") {
    for (const spelling of entry.arabic) {
      const isPhrase = /\s/.test(spelling.trim());
      const keys = isPhrase ? [phraseLookupKey(spelling)] : arabicTokenLookupKeys(spelling);
      for (const key of keys) FAMILY_ALIASES.set(key, entry.forms);
    }
  }
  // Brand entries are matched through BRAND_ALIASES; category/model/family
  // forms feed the Arabic token matcher.
  if (entry.kind !== "brand") {
    for (const spelling of entry.arabic) {
      const isPhrase = /\s/.test(spelling.trim());
      const keys = isPhrase ? [phraseLookupKey(spelling)] : arabicTokenLookupKeys(spelling);
      for (const key of keys) QUERY_ALIASES.set(key, entry.forms);
    }
  }
}

/** Exported read-only maps used by lib/relevance.ts (same shape the older
 *  local maps had, with the REEA-1218 coverage and normalized keys). */
export const ARABIC_BRAND_ALIASES: ReadonlyMap<string, string> = BRAND_ALIASES;
export const ARABIC_MODEL_ALIASES: ReadonlyMap<string, string> = MODEL_ALIASES;
export const ARABIC_QUERY_ALIASES: ReadonlyMap<string, readonly string[]> = QUERY_ALIASES;
export const ARABIC_PHRASE_ALIASES: ReadonlyMap<string, ArabicAliasEntry> = PHRASE_ALIASES;

/** The lexicon's curated Arabic empty-state suggestions (AC-4). Three
 *  concrete queries a Kuwaiti shopper can tap; every one is covered above. */
export const ARABIC_EMPTY_SUGGESTIONS: readonly string[] = ["غسالة", "لابتوب", "بانادول"];

/** The alias entry for one Arabic token, trying the folded form and the
 *  article-stripped form. */
export function arabicAliasEntryForToken(token: string): ArabicAliasEntry | null {
  for (const key of arabicTokenLookupKeys(token)) {
    const entry = TOKEN_ALIASES.get(key);
    if (entry) return entry;
  }
  return null;
}

/** Latin forms that answer one Arabic token, or [] for an unknown token. */
export function arabicAliasFormsForToken(token: string): readonly string[] {
  const entry = arabicAliasEntryForToken(token);
  if (entry) return entry.forms;
  const brand = arabicBrandForToken(token);
  return brand ? [brand.toLowerCase()] : [];
}

/** Curated same-family aliases (Panadol family) for one Arabic token. */
export function arabicFamilyAliasesForToken(token: string): readonly string[] {
  for (const key of arabicTokenLookupKeys(token)) {
    const aliases = FAMILY_ALIASES.get(key);
    if (aliases) return aliases;
  }
  return [];
}

/** Canonical curated brand for one Arabic token, or null. */
export function arabicBrandForToken(token: string): string | null {
  for (const key of arabicTokenLookupKeys(token)) {
    const brand = BRAND_ALIASES.get(key);
    if (brand) return brand;
  }
  return null;
}

/** The alias entry for a whole Arabic phrase (longest phrase first), or null
 *  when the query is not a curated phrase. */
export function arabicPhraseAliasForQuery(query: string): ArabicAliasEntry | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  return PHRASE_ALIASES.get(phraseLookupKey(tokens.join(" "))) ?? null;
}

export interface ArabicQueryAlias {
  /** The shopper's original query, trimmed. */
  from: string;
  /** The Latin spelling the live fan-out is dispatched under. */
  to: string;
  /** Every Latin form the matched tokens/phrases cover (for matching). */
  forms: readonly string[];
}

/**
 * REEA-1218 — the ONE alias fold for a shopper query. Walks the query
 * left-to-right, preferring the longest curated phrase (قدر ضغط → pressure
 * cooker) and then a curated token (غسالة → washing machine). Unknown tokens
 * ride through unchanged, so a mixed query keeps its uncurated part instead of
 * being silently dropped. Returns null when the query has no Arabic alias.
 *
 * This is used both by the dispatch bridge and by the AR substitution line, so
 * the line names exactly the spelling the live fan-out actually sent.
 */
export function arabicQueryAlias(query: string): ArabicQueryAlias | null {
  const trimmed = query.trim();
  if (trimmed === "" || !/[\u0600-\u06FF]/.test(trimmed)) return null;
  const rawTokens = trimmed.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const forms: string[] = [];
  let used = false;
  for (let i = 0; i < rawTokens.length; ) {
    let matched: { entry: ArabicAliasEntry; len: number } | null = null;
    for (let len = Math.min(3, rawTokens.length - i); len >= 2; len--) {
      const phrase = rawTokens.slice(i, i + len).join(" ");
      const entry = PHRASE_ALIASES.get(phraseLookupKey(phrase));
      if (entry) {
        matched = { entry, len };
        break;
      }
    }
    if (!matched) {
      const token = rawTokens[i];
      if (/[\u0600-\u06FF]/.test(token)) {
        const entry = arabicAliasEntryForToken(token);
        if (entry) matched = { entry, len: 1 };
      }
    }
    if (matched) {
      out.push(matched.entry.latin);
      forms.push(...matched.entry.forms);
      used = true;
      i += matched.len;
    } else {
      out.push(rawTokens[i]);
      i += 1;
    }
  }
  if (!used) return null;
  return { from: trimmed, to: out.join(" "), forms: Array.from(new Set(forms)) };
}
