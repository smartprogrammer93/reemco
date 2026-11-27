/**
 * REEA-1200 (Bet 7A-1) — the deterministic relevance/scope gate.
 *
 * The results shelf's first job is to show the thing the shopper asked for.
 * Measured live on `bd3806a3` (bet-7 Appendix A): `laptop` rendered 10 laptop
 * bags, `samsung galaxy s25 ultra` 1 phone + 9 cases/protectors, `cucumber`
 * 4 cucumbers + 6 soaps/drinks/pickles/a slime toy, `panadol` padded 4 real
 * rows to 10 with filler. The filler is inventory-driven and intermittent;
 * the padding itself is the defect.
 *
 * This module is the ONE scope decision. It is a deterministic classifier over
 * the existing collection output — no ML model, no second matcher, no bundled
 * catalogue:
 *  - `productScope` says what the card IS relative to the query
 *    (primary/variant = in scope; accessory/consumable = secondary band only);
 *  - `matchReason` says WHY it matched (query_token/brand_family/
 *    storefront_ranked/related). `related` is never a primary shelf slot.
 *
 * The class tables below reuse the curated category intents already in
 * lib/relevance.ts (laptop, headphones, air fryer, ps5, phones, tv, washing
 * machine) and add the consumable aisles the same live panel exposed (fresh
 * produce, food, beverage, personal care, household, medicine, toys, bags,
 * stationery). They are pure and locale-independent: EN and AR titles answer
 * the same class, so one query serves one shelf in both locales.
 *
 * Over-suppression is the risk this design must hold (bet-7 §2.10). The gate
 * only demotes a card when it can name a CONFLICTING class; a title with no
 * class noun stays in scope (a neutral class product such as an "Acer Aspire
 * 3 15.6-inch" is a laptop the retailer ranked for `laptop`, not filler), and
 * a query whose class is unknown only admits cards that carry its identity.
 */

import {
  arabicAliasFormsForToken,
  arabicFamilyAliasesForToken,
  arabicPhraseAliasForQuery,
  categoryClassesInTitle,
  categoryIntent,
  curatedBrandInTitle,
  dispatchIdentity,
  foldArabicForMatch,
  isAccessoryTitle,
  isModelAliasShape,
  latinBridgeDispatch,
  matchesModelIdentity,
  modelIdentityTokens,
  normalizeArabicText,
  normalizedTitle,
  skuCodeTokens,
  tierQueryTokens,
  titleCarriesCode,
  titleMatchesBrand,
} from "@/lib/relevance";
import type { MatchReason, ProductScope } from "@/types/product";

/** The one verdict shape every results card carries (AC 7a-1). */
export interface ScopeVerdict {
  matchReason: MatchReason;
  productScope: ProductScope;
}

/**
 * REEA-1200 AC 7a-6 — the ONE in-scope predicate the shelf renderer, the
 * counter and the probe share: a primary-shelf card is primary or variant
 * scope AND not merely `related`. Accessory/consumable cards never fill a
 * primary slot; `related`-matched cards (a different model, a different
 * product class) never fill one either.
 */
export function isPrimaryShelfScope(verdict: ScopeVerdict): boolean {
  return (
    (verdict.productScope === "primary" || verdict.productScope === "variant") &&
    verdict.matchReason !== "related"
  );
}

/* ---------------------------------------------------------------------------
 * Class tables. A class is a product aisle: the queried job. Two classes are
 * a conflict when a title names one the query does not. Consumable classes
 * land in the consumable bucket; every other conflict is an accessory.
 * ------------------------------------------------------------------------- */

/** Classes whose conflict means "a consumable, not the queried product". */
const CONSUMABLE_CLASSES: ReadonlySet<string> = new Set([
  "food",
  "beverage",
  "personal-care",
  "household",
  "medicine",
]);

/** Fresh-produce nouns (query side + title side). Whole-word EN; Arabic by
 *  normalized containment like the existing accessory markers. */
const PRODUCE_NOUNS: ReadonlySet<string> = new Set([
  "cucumber", "cucumbers", "tomato", "tomatoes", "potato", "potatoes",
  "onion", "onions", "carrot", "carrots", "lettuce", "cabbage", "spinach",
  "broccoli", "cauliflower", "mushroom", "mushrooms", "zucchini", "eggplant",
  "aubergine", "pepper", "peppers", "garlic", "ginger", "parsley", "mint",
  "coriander", "cilantro", "celery", "radish", "beetroot", "pumpkin", "corn",
  // REEA-1218 — "apple" stays OUT of the produce nouns: it is also the
  // device brand in every iPhone title ("Apple iPhone 17 Pro"), and treating
  // the brand as a produce class conflict demoted every iPhone row to the
  // accessory band. Fruit queries still carry their literal token ("apple")
  // through carriesQueryIdentity, so the shelf stays correct.
  "peas", "beans", "okra", "molokhia", "banana", "bananas",
  "orange", "oranges", "lemon", "lemons", "grape", "grapes", "strawberry",
  "strawberries", "watermelon", "melon", "mango", "mangoes", "avocado",
  "pineapple", "peach", "peaches", "plum", "plums", "cherry", "cherries",
  "apricot", "blueberry", "blueberries", "raspberry", "kiwi", "pomegranate",
  "fig", "figs", "date", "dates", "papaya", "coconut", "sweet potato",
]);

const PRODUCE_AR: readonly string[] = [
  "خيار", "طماطم", "بطاطس", "بصل", "جزر", "خس", "ملفوف", "سبانخ", "بروكلي",
  "قرنبيط", "فطر", "كوسا", "باذنجان", "فلفل", "ثوم", "زنجبيل", "بقدونس",
  "نعناع", "كزبرة", "كرفس", "فجل", "شمندر", "يقطين", "ذرة", "بازلاء",
  "بامية", "ملوخية", "تفاح", "موز", "برتقال", "ليمون", "عنب", "فراولة",
  "بطيخ", "شمام", "مانجو", "افوكادو", "اناناس", "خوخ", "برقوق", "كرز",
  "مشمش", "تين", "رمان", "جوافة", "باباي", "جوز الهند",
];

/** Title-side class patterns for the consumable/complement aisles. */
const CLASS_PATTERNS: readonly { id: string; re: RegExp }[] = [
  {
    id: "food",
    re: /\b(chocolates?|biscuits?|cookies?|cereal|cereals|bread|cheese|yogurt|yoghurt|butter|oil|rice|pasta|noodles?|sauce|ketchup|mayonnaise|honey|jam|snacks?|chips|candy|sweets?|nuts?|flour|sugar|salt|spices?|seasonings?|frozen|canned|pickles?|pickled|olives?|tuna|soup|vinegar|labneh|halva|baklava)\b/i,
  },
  {
    id: "beverage",
    re: /\b(drinks?|juice|juices|milk|laban|ayran|water|soda|cola|coffee|tea|beverage|nectar|smoothie)\b/i,
  },
  {
    id: "personal-care",
    re: /\b(soaps?|deodorants?|antiperspirants?|shampoos?|conditioners?|body ?wash|lotion|creams?|toothpaste|mouthwash|shav\w*|razors?|tissues?|wipes|cleansers?|serum|perfume|cologne|sunscreen)\b/i,
  },
  {
    id: "household",
    re: /\b(detergents?|dishwash\w*|bleach|disinfectants?|cleaners?|fabric softener|air fresheners?|insecticides?|paper towels?|foil|cling)\b/i,
  },
  {
    id: "medicine",
    re: /\b(tablets?|capsules?|syrup|medicine|medication|supplements?|vitamins?|collagen|painkillers?|ointment|drops)\b/i,
  },
  {
    id: "toy",
    re: /\b(toys?|slime|puzzles?|dolls?|lego)\b/i,
  },
  {
    id: "bags",
    re: /\b(bags?|backpacks?|trolleys?|suitcases?|luggage|pouches?|totes?)\b/i,
  },
  {
    // "pen"/"pencil" stay OUT: a bundled stylus ("... + Pen") is a laptop
    // accessory, not stationery, and demoting the Yoga 7 to the band was the
    // over-suppression this gate must not produce (measured live).
    id: "stationery",
    re: /\b(books?|textbooks?|cookbooks?|recipes?|papers?|card mat|craft|stationery)\b/i,
  },
  {
    id: "apparel",
    re: /\b(shirts?|t-shirts?|tshirts?|pants?|trousers?|dress(?:es)?|jackets?|socks?|shoes?|sneakers?|abayas?)\b/i,
  },
  {
    // Desk peripherals complement a laptop/PC rather than being it. Kept
    // separate from "accessory markers" because a bare "mouse" would not
    // match the marker list; this class makes it a conflict under `laptop`.
    id: "peripherals",
    re: /\b(mouse|mice|keyboards?|monitors?|webcams?|printers?|scanners?|usb hubs?|docking stations?|laptop stands?|projectors?)\b/i,
  },
];

/** Arabic title-side class words, normalized for containment matching. */
const CLASS_PATTERNS_AR: readonly { id: string; words: readonly string[] }[] = [
  {
    id: "food",
    words: ["شوكولاته", "بسكويت", "خبز", "جبن", "زبادي", "زبدة", "زيت", "ارز", "معكرونة", "صلصة", "كاتشب", "عسل", "مربى", "رقائق", "حلويات", "مكسرات", "دقيق", "سكر", "ملح", "توابل", "بهارات", "مجمد", "معلبات", "مخلل", "زيتون", "تونة", "حساء", "خل", "لبنة", "حلاوة", "بقلاوة"],
  },
  {
    id: "beverage",
    words: ["عصير", "حليب", "لبن", "رايب", "ماء", "مشروب", "مشروبات", "قهوة", "شاي", "نكتار", "سموذي", "كولا"],
  },
  {
    id: "personal-care",
    words: ["صابون", "مزيل", "شامبو", "بلسم", "لوشن", "كريم", "معجون", "غسول", "عطر", "مناديل", "واقي شمس", "سيروم"],
  },
  {
    id: "household",
    words: ["منظف", "غسيل", "مبيض", "معطر", "ورق", "فويل", "ملمع", "مطهر", "حشرات"],
  },
  {
    id: "medicine",
    words: ["اقراص", "قرص", "كبسولات", "شراب", "دواء", "مكملات", "فيتامين", "كولاجين", "مرهم", "قطرة"],
  },
  {
    id: "toy",
    words: ["لعبة", "العاب", "صلايم", "سلايم", "بازل", "دمية"],
  },
  {
    id: "bags",
    words: ["حقيبة", "شنطة", "شنط", "ترولي", "حقيبة ظهر"],
  },
  {
    id: "stationery",
    words: ["كتاب", "كتب", "دفتر", "اقلام", "قلم", "ورق"],
  },
  {
    id: "apparel",
    words: ["قميص", "تيشيرت", "بنطال", "جاكيت", "جوارب", "حذاء", "عباية"],
  },
];

/** The queried product class, or null when the query names no known class
 *  (an exact-model query such as `samsung galaxy s25 ultra`, or an unknown
 *  brand/word such as `panadol`). Pure and deterministic. */
export function queryProductClass(query: string): string | null {
  const intent = categoryIntent(query);
  if (intent) return intent.id;
  const folded = normalizeArabicText(normalizedTitle(query)).toLowerCase();
  const words = folded.split(/\s+/).filter(Boolean);
  if (words.some((w) => PRODUCE_NOUNS.has(w))) return "produce";
  if (PRODUCE_AR.some((w) => folded.includes(w))) return "produce";
  return null;
}

/** Every class a title names (curated category intents + consumable aisles). */
export function titleProductClasses(title: string): Set<string> {
  const lower = normalizedTitle(title).toLowerCase();
  const folded = normalizeArabicText(lower);
  const out = new Set<string>();
  for (const id of categoryClassesInTitle(title)) out.add(id);
  for (const { id, re } of CLASS_PATTERNS) if (re.test(lower)) out.add(id);
  for (const { id, words } of CLASS_PATTERNS_AR) {
    if (words.some((w) => folded.includes(w))) out.add(id);
  }
  const words = folded.split(/\s+/).filter(Boolean);
  if (words.some((w) => PRODUCE_NOUNS.has(w))) out.add("produce");
  if (PRODUCE_AR.some((w) => folded.includes(w))) out.add("produce");
  return out;
}

/**
 * REEA-1200 — does the title carry the query's own identity: every query
 * token in the folded title, the exact part-number code, or the query's model
 * identity? This is the textual `query_token` evidence; it deliberately does
 * NOT apply the accessory demotion, because an accessory that repeats the
 * full device identity (`... for Samsung Galaxy S25 Ultra`) DID match the
 * query's tokens — its scope, not its match reason, keeps it off the shelf.
 */
export function carriesQueryIdentity(query: string, title: string): boolean {
  const codes = skuCodeTokens(dispatchIdentity(query)).filter((c) => !isModelAliasShape(c));
  if (codes.length > 0 && titleCarriesCode(title, codes)) return true;
  const tokens = tierQueryTokens(query);
  const foldedTitle = foldArabicForMatch(normalizedTitle(title)).toLowerCase();
  if (tokens.length > 0 && tokens.every((t) => foldedTitle.includes(t))) return true;
  // REEA-1218 — every query token may also be answered by its curated Latin
  // form ("غسالة" → washing machine, "سامسونج" → samsung, "بانادول" →
  // panadol). Without this, a Latin-titled row under an Arabic query carried
  // no textual identity and the scope gate bucketed it as accessory.
  if (
    tokens.length > 0 &&
    tokens.every((t) => {
      if (foldedTitle.includes(t)) return true;
      if (!/[\u0600-\u06FF]/.test(t)) return false;
      return arabicAliasFormsForToken(t).some((form) => foldedTitle.includes(form));
    })
  ) {
    return true;
  }
  // Multi-word curated phrases ("قدر ضغط", "ال جي") carry identity as a
  // phrase even when a component token (the standalone "ال") has no Latin
  // form of its own.
  const phrase = arabicPhraseAliasForQuery(query);
  if (phrase && phrase.forms.some((form) => foldedTitle.includes(form))) return true;
  // The whole-query dispatch spelling is the same evidence in Latin script;
  // this covers phrases the per-token walk above cannot decompose.
  const bridged = latinBridgeDispatch(query);
  if (bridged !== query) {
    const bridgedTokens = tierQueryTokens(bridged);
    if (bridgedTokens.length > 0 && bridgedTokens.every((t) => foldedTitle.includes(t))) return true;
  }
  const models = modelIdentityTokens(query);
  if (models.length > 0) {
    const lower = title.toLowerCase();
    if (models.some((m) => matchesModelIdentity(lower, m))) {
      // REEA-1261 — a model token answered by ANOTHER brand is not the query's
      // identity. "v3" is Razer's Ornata V3 and Keychron's V3 Max alike, so a
      // Razer Ornata V3 must not answer "keychron v3 max" as a primary result.
      // The curated brand on the query is the missing half of the identity;
      // queries that name no curated brand (category/brand-only, "iphone 17
      // pro") keep the pre-change model-token evidence untouched.
      const queryBrand =
        curatedBrandInTitle(query) ??
        // REEA-1261 — an Arabic brand spelling rides its curated Latin bridge
        // ("سامسونج" → samsung), so the guard holds for the AR panel too.
        curatedBrandInTitle(latinBridgeDispatch(query));
      return queryBrand === null || titleMatchesBrand(title, queryBrand);
    }
  }
  return false;
}

/**
 * REEA-1200 — curated same-family aliases for a query that names one member
 * of a well-known product family. `panadol` is the paracetamol family the AC
 * names (Panadol, Panadrex, paracetamol): a shopper asking for Panadol gets
 * the same active ingredient from another brand, and the AC treats those rows
 * as in scope. Curated and small on purpose — an alias never widens a query
 * into a whole category (that is the class table's job).
 */
const QUERY_FAMILY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["panadol", ["panadol", "panadrex", "paracetamol"]],
  ["panadrex", ["panadol", "panadrex", "paracetamol"]],
  ["paracetamol", ["panadol", "panadrex", "paracetamol"]],
]);

/** True when a title carries a curated same-family alias of the query. */
export function carriesFamilyAlias(query: string, title: string): boolean {
  const tokens = tierQueryTokens(query);
  if (tokens.length !== 1) return false;
  // REEA-1218 — Arabic pharmacy spellings (بانادول/بنادول) ride the same
  // curated Panadol family the Latin query uses.
  const aliases =
    QUERY_FAMILY_ALIASES.get(tokens[0]) ?? arabicFamilyAliasesForToken(tokens[0]);
  if (!aliases || aliases.length === 0) return false;
  const foldedTitle = foldArabicForMatch(normalizedTitle(title)).toLowerCase();
  return aliases.some((alias) => new RegExp(`\\b${alias}\\b`, "i").test(foldedTitle));
}

/**
 * REEA-1200 — model-identity guard for an exact-model query. When the query
 * names a model token ("s25", "iphone17", "tune500"), a title that does not
 * answer it is a different product, whatever else it shares: S25 ≠ S26,
 * Tune 500 ≠ Tune 510BT. Queries without a model token always pass.
 */
export function modelIdentityPasses(query: string, title: string): boolean {
  const models = modelIdentityTokens(query);
  if (models.length === 0) return true;
  const lower = title.toLowerCase();
  return models.some((m) => matchesModelIdentity(lower, m));
}

/** Pack-size/capacity variant of the same product: "Cucumber 1kg",
 *  "Cucumber (Tray) 900g", "iPhone 17 Pro 256Gb". Still in scope (AC 7a-3
 *  allows pack-size variants on the primary shelf), but classified as a
 *  variant so the payload states it. */
const PACK_VARIANT_RE =
  /\b\d+(?:\.\d+)?\s?(?:kg|g|ml|l|oz|lb)\b|\b\d+\s?(?:gb|tb)\b|\b(pack|packs|tray|trays|multipack|pack of|pieces?|pcs)\b|كجم|كيلو|كيلوجرام|جرام|جم|لتر|ملل|مل\b|اوقية|باوند/i;

export function isPackVariant(title: string): boolean {
  return PACK_VARIANT_RE.test(normalizedTitle(title));
}

function inScopeReason(query: string, title: string): MatchReason {
  if (carriesQueryIdentity(query, title)) return "query_token";
  // A curated same-family alias (Panadrex for Panadol) is a brand-family
  // match, not a token match: the title never spelled the queried word.
  if (carriesFamilyAlias(query, title)) return "brand_family";
  const brand = curatedBrandInTitle(query);
  if (brand && titleMatchesBrand(title, brand)) return "brand_family";
  // The retailer's own ranking placed a neutral class product under the
  // query's class without token evidence in the title (e.g. an "Acer Aspire
  // 3 15.6-inch" under `laptop`). Honest: it is in scope by class, not by
  // the title's text.
  return "storefront_ranked";
}

/**
 * REEA-1200 AC 7a-1 — classify one card against the query. Pure,
 * deterministic and locale-independent (the tables carry EN and AR forms).
 *
 * Decision order (the order is the contract):
 *  1. accessory-marked title under a non-accessory query → accessory;
 *  2. a class conflict with a known query class → consumable when the
 *     conflicting aisle is consumable, else accessory;
 *  3. exact-model query whose model identity the title does not carry →
 *     off-scope (`related`), never a primary slot;
 *  4. otherwise in scope by class or identity → primary/variant.
 */
export function classifyProductScope(query: string, title: string): ScopeVerdict {
  const q = normalizedTitle(query);
  if (q === "" || normalizedTitle(title) === "") {
    return { matchReason: "related", productScope: "accessory" };
  }
  const carries = carriesQueryIdentity(query, title);
  const titleClasses = titleProductClasses(title);
  const queryClass = queryProductClass(query);

  // 0. Exact part-number intent (REEA-721/REEA-822) outranks the accessory
  //    demotion: an exact-SKU query is about THAT listing, even when the
  //    title says "Case". The code shape is read off the dispatch identity,
  //    mirroring the confidence ladder's override exactly; a compact model
  //    alias ("s25", "fold7") is a family, not a pasted part number, so it
  //    does not take this branch.
  const exactCodes = skuCodeTokens(dispatchIdentity(query)).filter((c) => !isModelAliasShape(c));
  if (exactCodes.length > 0 && titleCarriesCode(title, exactCodes)) {
    return {
      matchReason: "query_token",
      productScope: isPackVariant(title) ? "variant" : "primary",
    };
  }

  // 1. The shopper asked for a device/product; an accessory-marked title
  //    ("... Case", "... Screen Protector", "... Cable") is the companion
  //    product, never a peer. An accessory query ("iphone 17 pro case") keeps
  //    its accessories primary — the marker is then the product itself.
  if (isAccessoryTitle(title) && !isAccessoryTitle(query)) {
    return { matchReason: carries ? "query_token" : "related", productScope: "accessory" };
  }

  // 2. Class conflict: the title names an aisle the query's class does not.
  if (queryClass) {
    const conflicts = [...titleClasses].filter((c) => c !== queryClass);
    if (conflicts.length > 0) {
      const consumable = conflicts.some((c) => CONSUMABLE_CLASSES.has(c));
      return {
        matchReason: carries ? "query_token" : "related",
        productScope: consumable ? "consumable" : "accessory",
      };
    }
    return {
      matchReason: inScopeReason(query, title),
      productScope: isPackVariant(title) ? "variant" : "primary",
    };
  }

  // 3. Exact-model / unknown-class query: only a card that answers the
  //    query's identity (or a curated same-family alias, e.g. Panadrex under
  //    `panadol`) is in scope. A same-class row that misses the model
  //    (S26 under `s25 ultra`) is related, not a primary slot.
  if ((carries || carriesFamilyAlias(query, title)) && modelIdentityPasses(query, title)) {
    return {
      matchReason: inScopeReason(query, title),
      productScope: isPackVariant(title) ? "variant" : "primary",
    };
  }

  // 4. Out of scope: bucket by the aisle the title names (a dishwasher
  //    tablet is a consumable; a webcam or a card mat is an accessory).
  const consumable = [...titleClasses].some((c) => CONSUMABLE_CLASSES.has(c));
  return {
    matchReason: carries ? "query_token" : "related",
    productScope: consumable ? "consumable" : "accessory",
  };
}

/**
 * REEA-1200 AC 7a-1 — stamp the verdict on every served card. Called on every
 * results snapshot at serve time (fresh fan-out, finalized, memo/KV replay),
 * so a snapshot stored before this change still answers with the fields and a
 * card can never reach the shelf unclassified.
 */
export function stampScopeFields<T extends { title: string }>(
  query: string,
  products: readonly T[],
): (T & ScopeVerdict)[] {
  return products.map((p) => ({ ...p, ...classifyProductScope(query, p.title) }));
}
