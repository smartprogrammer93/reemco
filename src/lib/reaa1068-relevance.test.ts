/**
 * REEA-1068 — spaced model spellings must be equivalent to their compact
 * form. Regression fixtures mirror the live answers measured for the defect:
 * `fold7` led with the Galaxy Z Fold7 phone set while `fold 7` collapsed to
 * the loose word "fold" and surfaced folding tables / pressure washers.
 *
 * The acceptance bar these tests pin:
 *  1. `fold 7` accepts Fold7 / "Fold 7" rows and rejects Foldable table /
 *     washer rows at the adapter gate.
 *  2. `fold7`, `fold 7`, and `Fold 7` rank the same hit set identically.
 *  3. `foldable table`, `galaxy z fold 7`, and `iphone 16 pro` keep their
 *     correct sets (no over-correction).
 */
import "@/lib/collect/test-cache-dir";
import { describe, expect, it } from "vitest";
import {
  compactDispatchQuery,
  compactQueryTokens,
  isAccessoryTitle,
  isModelExtended,
  latinBridgeDispatch,
  matchesCompactQueryToken,
  matchesModelIdentity,
  modelIdentityTokens,
  relevanceTier,
} from "@/lib/relevance";
import { queryGatePasses } from "@/lib/collect/search-fallback";
import { groupHits, xciteHits, type SearchHit } from "@/lib/collect/live-search";

const MIN_SCORE = 0.25;

const FOLD7_PHONE = "Samsung Galaxy Z Fold7 5G 256GB Phone - Blue";
const FOLD7_SPACED = "Samsung Z Fold 7, 5G, 512 GB, 16 GB, 8\", W26 Chinese Version";
const FOLD8 = "Samsung Galaxy Z Fold 8 Ultra 5G 12GB RAM 256GB";
const FOLDABLE_TABLE = "Naturehike FT07 Foldable Camping Table - Black";
const FOLDABLE_WASHER = "Fanttik NB10 Fold Foldable Pressure Washer - Black";
const FOLD7_BRACKET = "Smartix Ultraguard Magnetic Bundle for Samsung Galaxy Z Fold 7 - Clear";
const NATUREHIKE = "Naturehike FT07 Foldable Camping Table - Black";

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "Samsung Galaxy Z Fold7 5G 256GB Phone - Blue",
    merchant: "Xcite",
    price: 379.9,
    currency: "KWD",
    url: "https://xcite.example/fold7",
    inStock: true,
    country: "KW",
    ...over,
  };
}

describe("REEA-1068 — compact model spelling", () => {
  it("a whole word+digit query dispatches under its compact spelling", () => {
    expect(compactDispatchQuery("fold 7")).toBe("fold7");
    expect(compactDispatchQuery("Fold 7")).toBe("fold7");
    expect(compactDispatchQuery("  fold   7 ")).toBe("fold7");
    expect(compactDispatchQuery("fold, 7")).toBe("fold7");
    // Longer phrases and plain category queries keep their spelling.
    expect(compactDispatchQuery("galaxy z fold 7")).toBe("galaxy z fold 7");
    expect(compactDispatchQuery("iphone 16 pro")).toBe("iphone 16 pro");
    expect(compactDispatchQuery("foldable table")).toBe("foldable table");
    expect(compactDispatchQuery("fold7")).toBe("fold7");
  });

  it("query tokens fold to one model token without swallowing the word", () => {
    expect(compactQueryTokens("fold 7")).toEqual(["fold7"]);
    expect(compactQueryTokens("Fold 7")).toEqual(["fold7"]);
    expect(compactQueryTokens("fold7")).toEqual(["fold7"]);
    expect(compactQueryTokens("galaxy z fold 7")).toEqual(["galaxy", "fold7"]);
    expect(compactQueryTokens("iphone 16 pro")).toEqual(["iphone16", "pro"]);
    expect(compactQueryTokens("foldable table")).toEqual(["foldable", "table"]);
  });

  it("the model token matches both storefront spellings and not Foldable/Fold8", () => {
    expect(matchesCompactQueryToken(FOLD7_PHONE.toLowerCase(), "fold7")).toBe(true);
    expect(matchesCompactQueryToken(FOLD7_SPACED.toLowerCase(), "fold7")).toBe(true);
    expect(matchesCompactQueryToken(FOLD7_BRACKET.toLowerCase(), "fold7")).toBe(true);
    expect(matchesCompactQueryToken(FOLDABLE_TABLE.toLowerCase(), "fold7")).toBe(false);
    expect(matchesCompactQueryToken(FOLDABLE_WASHER.toLowerCase(), "fold7")).toBe(false);
    expect(matchesCompactQueryToken(FOLD8.toLowerCase(), "fold7")).toBe(false);
    // Model containment still works for hyphenated part numbers.
    expect(matchesCompactQueryToken("sony wh-1000xm6 wireless headphones", "xm6")).toBe(true);
  });

  it("the adapter gate rejects the Foldable noise and keeps the Fold7 set", () => {
    for (const q of ["fold 7", "fold7", "Fold 7"]) {
      expect(queryGatePasses(FOLD7_PHONE, q, MIN_SCORE)).toBe(true);
      expect(queryGatePasses(FOLD7_SPACED, q, MIN_SCORE)).toBe(true);
      expect(queryGatePasses(FOLD7_BRACKET, q, MIN_SCORE)).toBe(true);
      expect(queryGatePasses(FOLDABLE_TABLE, q, MIN_SCORE)).toBe(false);
      expect(queryGatePasses(FOLDABLE_WASHER, q, MIN_SCORE)).toBe(false);
      expect(queryGatePasses(FOLD8, q, MIN_SCORE)).toBe(false);
    }
  });

  it("the xcite adapter keeps only the Fold7 rows for the spaced spelling", () => {
    const payload = {
      results: [
        {
          hits: [
            { name: FOLD7_PHONE, slug: "fold7-blue", price: 379.9, currency: "KWD", inStock: true },
            { name: FOLDABLE_TABLE, slug: "table", price: 6.9, currency: "KWD", inStock: true },
            { name: FOLDABLE_WASHER, slug: "washer", price: 59, currency: "KWD", inStock: true },
            { name: FOLD8, slug: "fold8", price: 502.9, currency: "KWD", inStock: true },
          ],
        },
      ],
    };
    // The dispatcher hands the compact spelling to the adapter; the raw
    // shopper spelling must also gate identically if it reaches a parser.
    for (const q of ["fold7", "fold 7"]) {
      const hits = xciteHits(payload, q);
      expect(hits.map((h) => h.title)).toEqual([FOLD7_PHONE]);
    }
  });

  it("tiers the Fold7 phone above the folding table/washer for every spelling", () => {
    const phoneTier = relevanceTier("fold 7", FOLD7_PHONE);
    expect(phoneTier).toBeGreaterThan(0);
    expect(relevanceTier("fold 7", FOLDABLE_TABLE)).toBe(0);
    expect(relevanceTier("fold 7", FOLDABLE_WASHER)).toBe(0);
    expect(relevanceTier("fold 7", FOLD7_SPACED)).toBe(phoneTier);
    // Spelling equivalence on the same row.
    expect(relevanceTier("fold7", FOLD7_PHONE)).toBe(phoneTier);
    expect(relevanceTier("Fold 7", FOLD7_PHONE)).toBe(phoneTier);
    expect(relevanceTier("fold7", FOLD7_SPACED)).toBe(phoneTier);
  });

  it("galaxy z fold 7 ranks Fold7 above Fold8 (compact token, not loose word)", () => {
    expect(relevanceTier("galaxy z fold 7", FOLD7_PHONE)).toBeLessThan(
      relevanceTier("galaxy z fold 7", FOLD8),
    );
  });

  it("no over-correction: foldable table and iphone 16 pro keep their sets", () => {
    expect(queryGatePasses(NATUREHIKE, "foldable table", MIN_SCORE)).toBe(true);
    expect(queryGatePasses(FOLD7_PHONE, "foldable table", MIN_SCORE)).toBe(false);
    expect(relevanceTier("foldable table", NATUREHIKE)).toBeGreaterThan(0);

    const iphone = "Apple iPhone 16 Pro, 256 GB, Desert Titanium, 5G";
    expect(queryGatePasses(iphone, "iphone 16 pro", MIN_SCORE)).toBe(true);
    expect(relevanceTier("iphone 16 pro", iphone)).toBe(1);
    expect(relevanceTier("iphone 16 pro", "Apple iPhone 16 Pro Clear Case with MagSafe")).toBe(1);
    expect(isModelExtended("iphone 16 pro", "Apple iPhone 16 Pro Max, 256 GB")).toBe(true);
    expect(isModelExtended("iphone 16 pro", "Apple iPhone 16 Pro, 256 GB")).toBe(false);
  });

  it("accessory-class bundles/protection rings sit below the phone set", () => {
    // REEA-1068 — the magnetic bundle and the lens ring are add-on packs, not
    // devices; Rule 2 keeps them out of the device block the phones lead.
    expect(isAccessoryTitle(FOLD7_BRACKET)).toBe(true);
    expect(
      isAccessoryTitle("Araree Camera Lens Ring Protection - Samsung Galaxy Z Fold 7 / Clear"),
    ).toBe(true);
    expect(isAccessoryTitle(FOLD7_PHONE)).toBe(false);
  });

  it("D2 — a camera-glass lens cover that repeats the device identity stays off the phone card", () => {
    // QA live repro: Wibi's "Smartix Ultraguard Camera Glass for Samsung
    // Galaxy Z Fold7" carried the full device identity in its title, so the
    // canonical tuple merged it into the phone card and its KD 5.50 became
    // the card's Best price (product page: KD 385/379.90). "camera glass" is
    // an accessory marker now, so the lens cover forms its own class.
    const cameraGlass = "Smartix Ultraguard Camera Glass for Samsung Galaxy Z Fold7 - Clear";
    expect(isAccessoryTitle(cameraGlass)).toBe(true);
    expect(isAccessoryTitle("Wansa Glass Heater Foldable Table")).toBe(false); // bare "glass" is not a marker
    const hits: SearchHit[] = [
      hit({ title: FOLD7_PHONE, merchant: "Xcite", price: 379.9, url: "https://xcite.example/f7" }),
      hit({ title: "Samsung Galaxy Z Fold7, 5G, 12 GB RAM", merchant: "Blink", price: 385, url: "https://blink.example/f7" }),
      hit({ title: "Samsung Galaxy Z Fold7, 5G, 12 GB RAM", merchant: "Eureka", price: 494.9, url: "https://eureka.example/f7" }),
      hit({ title: cameraGlass, merchant: "Wibi", price: 5.5, url: "https://wibi.example/f7-glass" }),
    ];
    const products = groupHits("fold7", hits);
    const phone = products.find((p) => p.title.includes("Fold7") && !isAccessoryTitle(p.title));
    expect(phone).toBeDefined();
    // The KD 5.50 lens cover is not one of the phone card's offers…
    expect(phone!.offers.map((o) => o.merchant)).not.toContain("Wibi");
    // …so the lead figure is a matched-phone price, never the accessory's.
    expect(phone!.offers[0].price).toBeGreaterThan(5.5);
    // The accessory still reaches its own card (nothing is hidden).
    expect(products.some((p) => p.title === cameraGlass)).toBe(true);
  });

  it("grouping+ranking produces the same card set for fold7 / fold 7 / Fold 7", () => {
    // The measured fold7 payload, plus the noise rows the broken gate used to
    // admit for `fold 7`. Each spelling runs through the same adapter gate the
    // dispatcher applies (compact dispatch) before grouping.
    const payload: SearchHit[] = [
      hit({ title: FOLD7_PHONE, merchant: "Xcite", price: 379.9, url: "https://xcite.example/f7" }),
      hit({ title: FOLD7_SPACED, merchant: "Blink", price: 950, url: "https://blink.example/f7" }),
      hit({ title: "Panzerglass Camera Lens Protector For Galaxy Z Fold7 PG22394", merchant: "Eureka", price: 1.5, url: "https://eureka.example/f7-lens" }),
      hit({ title: "PanzerGlass Urban Combat Case, for Samsung Galaxy Z Fold7, Clear", merchant: "Jarir", price: 58, currency: "SAR", url: "https://jarir.example/f7-case" }),
      hit({ title: FOLD7_BRACKET, merchant: "Wibi", price: 8.5, url: "https://wibi.example/f7-bracket" }),
      hit({ title: FOLD8, merchant: "Switch", price: 547.9, url: "https://switch.example/f8" }),
      hit({ title: FOLDABLE_TABLE, merchant: "Astore", price: 62, url: "https://astore.example/table" }),
      hit({ title: FOLDABLE_WASHER, merchant: "Astore", price: 59, url: "https://astore.example/washer" }),
    ];
    const run = (q: string) => {
      const dispatch = compactDispatchQuery(q);
      const admitted = payload.filter((h) => queryGatePasses(h.title, dispatch, MIN_SCORE));
      return groupHits(q, admitted);
    };
    const compact = run("fold7");
    const spaced = run("fold 7");
    const capital = run("Fold 7");
    expect(spaced.map((p) => p.productId)).toEqual(compact.map((p) => p.productId));
    expect(capital.map((p) => p.productId)).toEqual(compact.map((p) => p.productId));
    // Fold7 phone leads; no folding table / washer anywhere in the set.
    expect(compact[0].title).toContain("Fold7");
    expect(isAccessoryTitle(compact[0].title)).toBe(false);
    const titles = compact.map((p) => p.title);
    expect(titles).not.toContain(FOLDABLE_TABLE);
    expect(titles).not.toContain(FOLDABLE_WASHER);
  });
});

describe("REEA-1068 — model-identity guard and Arabic model spellings", () => {
  it("Arabic model words fold to the same identity token as their Latin form", () => {
    // "فولد 7" (the Arabic transliteration of Fold 7) must dispatch and match
    // like "fold 7" instead of collapsing to the loose Arabic word.
    expect(compactQueryTokens("فولد 7")).toEqual(["fold7"]);
    expect(compactDispatchQuery(latinBridgeDispatch("فولد 7"))).toBe("fold7");
    expect(compactQueryTokens("آيفون 17")).toEqual(["iphone17"]);
    expect(compactDispatchQuery(latinBridgeDispatch("آيفون 17"))).toBe("iphone17");
    // Arabic pharmacy word answers Latin-titled Panadol rows.
    expect(compactQueryTokens("بنادول")).toEqual(["panadol"]);
    expect(queryGatePasses("Panadol Extra Pain Relief Tablets 24tablets", "بنادول", MIN_SCORE)).toBe(true);
    expect(queryGatePasses(FOLD7_PHONE, "فولد 7", MIN_SCORE)).toBe(true);
    expect(queryGatePasses(FOLDABLE_TABLE, "فولد 7", MIN_SCORE)).toBe(false);
  });

  it("a model-identity query rejects rows that only answer a loose word", () => {
    // Live defect: "iPhone 17 Pro" admitted RAZER gaming mice on the "Pro"
    // token. The identity token (iphone17) is the category guard.
    expect(modelIdentityTokens("iPhone 17 Pro")).toEqual(["iphone17"]);
    expect(matchesModelIdentity("razer deathadder v3 pro gaming mouse", "iphone17")).toBe(false);
    expect(queryGatePasses("RAZER DeathAdder V3 Pro Gaming Mouse", "iPhone 17 Pro", MIN_SCORE)).toBe(false);
    expect(queryGatePasses("Apple iPhone 17 Pro 256Gb Silver", "iPhone 17 Pro", MIN_SCORE)).toBe(true);
    expect(queryGatePasses("Apple iPhone 17 Pro Max 1TB", "iPhone 17 Pro", MIN_SCORE)).toBe(true);
    expect(queryGatePasses("Apple iPhone 17 Pro Clear Case with MagSafe", "iPhone 17 Pro", MIN_SCORE)).toBe(true);
    // Spec quantities are not identities: "256gb" / "5000mah" never gate.
    expect(modelIdentityTokens("Pro 256 GB")).toEqual([]);
    expect(modelIdentityTokens("powerbank 5000mah")).toEqual([]);
    expect(queryGatePasses("Anker Powerbank 5000mAh", "powerbank 5000mah", MIN_SCORE)).toBe(true);
  });

  it("the identity guard leaves the no-over-correction queries alone", () => {
    // "iphone case" carries no digit identity: every case stays admissible.
    expect(modelIdentityTokens("iphone case")).toEqual([]);
    expect(queryGatePasses("Apple iPhone 16 Pro Clear Case with MagSafe", "iphone case", MIN_SCORE)).toBe(true);
    expect(modelIdentityTokens("laptop")).toEqual([]);
    expect(queryGatePasses("HP Laptop, AMD Ryzen 5, 8GB RAM", "laptop", MIN_SCORE)).toBe(true);
    expect(modelIdentityTokens("foldable table")).toEqual([]);
    expect(queryGatePasses(NATUREHIKE, "foldable table", MIN_SCORE)).toBe(true);
    // Titles that spell a model apart still answer it (generation numbers).
    expect(matchesModelIdentity("apple airpods pro (2nd generation)", "pro2")).toBe(true);
    expect(matchesModelIdentity("apple airpods pro", "pro2")).toBe(false);
  });
});
