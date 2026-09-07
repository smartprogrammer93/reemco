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
  "Araree", "RINGKE", "GRABIST", "GravaStar",
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
  "كفر", "جراب", "واقي", "غطاء",
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
 */
export function resolveBrand(brandField: string | undefined, title: string): string {
  const field = (brandField ?? "").trim();
  if (field !== "") {
    const stop = BRAND_STOP_VALUES.some((s) => s.toLowerCase() === field.toLowerCase());
    if (!stop) {
      // Casing normalization against the curated list: SONY/Sony → Sony.
      // Unknown brand values stay exactly as they arrived.
      const lower = field.toLowerCase();
      for (const entry of CURATED_BRANDS) {
        if (entry.toLowerCase() === lower) return entry;
      }
      return field;
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

/** Rule 2 gate: device intent when ANY matched title carries a curated brand
 *  or a model-number token. Everything below keeps the current single-list
 *  behavior otherwise. */
export function titleHasDeviceIntent(title: string): boolean {
  return curatedBrandInTitle(title) !== null || MODEL_TOKEN_RE.test(title);
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
