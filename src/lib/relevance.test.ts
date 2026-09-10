/**
 * REEA-189 — relevance-tiering + brand-hygiene unit coverage (REEA-180 spec).
 * Fixtures mirror what the four retailer adapters actually emit on the
 * sampled queries: English-style titles for "آيفون 17", Arabic-script titles
 * for "سماعة أبل", artifact-first-word titles from case listings.
 */
import { describe, expect, it } from "vitest";
import {
  CURATED_BRANDS,
  arabicBrandIntent,
  brandIsNamed,
  curatedBrandInTitle,
  isAccessoryTitle,
  isModelExtended,
  matchesQueryToken,
  normalizeArabicText,
  partitionForQuery,
  relevanceTier,
  resolveBrand,
  titleHasDeviceIntent,
  titleMatchesBrand,
} from "@/lib/relevance";

describe("brand resolution (Rule 1)", () => {
  it("trimmed retailer brand field wins, casing normalized to the curated list", () => {
    expect(resolveBrand("SONY", "WH-1000XM6 Wireless Headphones")).toBe("Sony");
    expect(resolveBrand(" samsung ", "Galaxy Buds3 Pro")).toBe("Samsung");
    expect(resolveBrand("NILLKIN", "NILLKIN Power Chip 5000")).toBe("NILLKIN");
  });

  it("unknown brand values stay as-is", () => {
    expect(resolveBrand("Zowie", "Zowie XL2566K")).toBe("Zowie");
  });

  it("artifact stop-values count as missing and fall through to the title match", () => {
    expect(resolveBrand("Privacy", "Sony WH-1000XM6 Headphones")).toBe("Sony");
    expect(resolveBrand("Case", "Bose QuietComfort Ultra Earbuds")).toBe("Bose");
    expect(resolveBrand("compatible", "Compatible with Nothing Phone (3a)")).toBe("Nothing");
  });

  it("title fallback matches curated brands as whole words, longest entry first", () => {
    expect(curatedBrandInTitle("Nothing Phone (3a) Plus 256GB")).toBe("Nothing");
    expect(curatedBrandInTitle("Head & Shoulders Clean Balance 470ml")).toBe("Head & Shoulders");
    expect(curatedBrandInTitle("Kellogg's Corn Flakes 530g")).toBe("Kellogg's");
    // Hyphen entries also match their spaced spelling.
    expect(curatedBrandInTitle("Coca Cola Zero Sugar 330ml")).toBe("Coca-Cola");
    // Whole word: HP inside HPE must not fire.
    expect(curatedBrandInTitle("HPE Aruba Access Point")).toBeNull();
  });

  it("no brand source means no brand line — never the arbitrary first title word", () => {
    expect(resolveBrand(undefined, "Quiet Comfort 300 Speaker")).toBe("");
    expect(resolveBrand("", "Compatible with Airfryer XL Basket")).toBe("");
    expect(resolveBrand("For", "Araree Bean Earbuds Case")).toBe("Araree");
  });
});

describe("accessory classification (Rule 2)", () => {
  it("EN markers classify a card as accessory", () => {
    expect(isAccessoryTitle("Samsung Galaxy Buds3 Pro Case Cover")).toBe(true);
    expect(isAccessoryTitle("Tempered Glass Screen Protector for Xiaomi")).toBe(true);
    expect(isAccessoryTitle("COVER for Bose QuietComfort")).toBe(true);
  });

  it("AR markers classify a card as accessory", () => {
    expect(isAccessoryTitle("كفر سيليكون لآيفون")).toBe(true);
    expect(isAccessoryTitle("جراب هواة بومبو")).toBe(true);
    expect(isAccessoryTitle("واقي شاشة سامسونج")).toBe(true);
    expect(isAccessoryTitle("غطاء حماية لابتوب")).toBe(true);
  });

  it("device titles without markers stay device", () => {
    expect(isAccessoryTitle("Sony WH-1000XM6 Wireless Headphones")).toBe(false);
    expect(isAccessoryTitle("Apple iPhone 17 Pro 6.3\" 256GB")).toBe(false);
    expect(isAccessoryTitle("سماعة القرآن الكريم للاطفال")).toBe(false);
  });
});

describe("device-intent tiering (Rules 2–3)", () => {
  it("curated brands and letter+digit model tokens signal device intent", () => {
    expect(titleHasDeviceIntent("Sony WH-1000XM6")).toBe(true);
    expect(titleHasDeviceIntent("Apple iPhone 17 Pro")).toBe(true);
    expect(titleHasDeviceIntent("Samsung Galaxy Buds 3 White")).toBe(true);
    expect(titleHasDeviceIntent("آيفون 17 برو مكس")).toBe(true);
  });

  it("plain titles without brand or model token keep the single-list behavior", () => {
    expect(titleHasDeviceIntent("سماعة القرآن الكريم للاطفال")).toBe(false);
    expect(titleHasDeviceIntent("Ceramic Mug White")).toBe(false);
  });

  it("stacks devices above accessories, order inside each container untouched", () => {
    const list = [
      { productId: "a", title: "Samsung Galaxy Buds3 Pro" },
      { productId: "b", title: "RINGKE Onyx Earbuds Case" },
      { productId: "c", title: "Samsung Galaxy Buds FE" },
    ];
    const tier = partitionForQuery(list);
    expect(tier.tiered).toBe(true);
    expect(tier.devices.map((p) => p.productId)).toEqual(["a", "c"]);
    expect(tier.accessories.map((p) => p.productId)).toEqual(["b"]);
  });

  it("non-device queries and single-kind lists keep the plain list", () => {
    const plain = partitionForQuery([{ productId: "a", title: "Ceramic Mug White" }]);
    expect(plain.tiered).toBe(false);
    const allDevices = partitionForQuery([
      { productId: "a", title: "Sony WH-1000XM6" },
      { productId: "b", title: "Sony WH-CH720N" },
    ]);
    expect(allDevices.tiered).toBe(false);
  });

  it("curated list stays inside the spec cap of 75 entries", () => {
    expect(CURATED_BRANDS.length).toBeLessThanOrEqual(75);
  });
});

describe("Arabic brand-token matching (REEA-195)", () => {
  it("an Arabic brand spelling is answered by the curated Latin form", () => {
    // The QA-reported shape: Arabic query, English-index title. Plain
    // substring coverage is 0 across scripts; the alias bridge closes it.
    expect(matchesQueryToken("apple airpods 4 - white", "أبل")).toBe(true);
    expect(matchesQueryToken("samsung galaxy buds fe", "سامسونج")).toBe(true);
    // Hamza variants of the same spelling share one alias key.
    expect(matchesQueryToken("apple iphone 17 pro", "آبل")).toBe(true);
    expect(matchesQueryToken("apple iphone 17 pro", "ابل")).toBe(true);
  });

  it("non-brand tokens and Latin queries keep the plain substring path", () => {
    expect(matchesQueryToken("sony wh-1000xm6 headphones", "sony")).toBe(true);
    expect(matchesQueryToken("boase quietcomfort", "bose")).toBe(false);
    expect(matchesQueryToken("سماعة القرآن للأطفال", "سماعة")).toBe(true);
  });

  it("an ASCII token answers an accented Latin title (REEA-416 accent fold)", () => {
    // Deployed shape: Quadra titles carry "NESCAFÉ"/"Café" while the shopper
    // query — tokenized to ASCII stems — reads "nescafe". Without the
    // title-side fold the coverage score is 0 on every record and the whole
    // column goes silent despite a populated live payload.
    expect(matchesQueryToken("nescafé classic jar 200g", "nescafe")).toBe(true);
    expect(matchesQueryToken("L'OR CAFÉ capsules", "cafe")).toBe(true);
    // The fold must not invent matches: a different stem still misses.
    expect(matchesQueryToken("nescafé classic jar 200g", "telecaf")).toBe(false);
  });

  it("Arabic brand queries name the brand for lead ordering", () => {
    expect(arabicBrandIntent("سماعة أبل")).toBe("Apple");
    expect(arabicBrandIntent("آيفون 17")).toBe("Apple");
    expect(arabicBrandIntent("سماعات سامسونج")).toBe("Samsung");
    // No brand token → untouched ordering; Latin-only queries never enter.
    expect(arabicBrandIntent("سماعة بلوتوث")).toBeNull();
    expect(arabicBrandIntent("apple airpods")).toBeNull();
  });

  it("brand lead matching reads Latin and Arabic spellings of the brand", () => {
    expect(titleMatchesBrand("Apple Airpods 4 - White", "Apple")).toBe(true);
    expect(titleMatchesBrand("سماعة أبل لاسلكية", "Apple")).toBe(true);
    expect(titleMatchesBrand("Samsung Galaxy Buds FE", "Apple")).toBe(false);
  });

  it("empty retailer brand fields fall back through the curated title match", () => {
    // The blank brand lines from the fold7 pass (pg68903, pg22394, cr60744):
    // no retailer brand field, title carries the brand — the curated fallback
    // fills the line with one canonical casing; the longest entry wins over
    // the fitted-device brand inside the same title.
    expect(resolveBrand(undefined, "PanzerGlass Urban Fit for Samsung Galaxy S26")).toBe("PanzerGlass");
    expect(resolveBrand("", "PanzerGlass Screen Protector")).toBe("PanzerGlass");
  });
});

describe("Arabic normalization (REEA-213)", () => {
  it("folds tashkeel and tatweel so vowelled and plain spellings meet", () => {
    expect(normalizeArabicText("غسّالة")).toBe(normalizeArabicText("غسالة"));
    expect(normalizeArabicText("غــسالة")).toBe(normalizeArabicText("غسالة"));
    // Fathatan + sukun tails ride the same strip.
    expect(normalizeArabicText("غسالةً")).toBe(normalizeArabicText("غسالة"));
  });

  it("keeps the hamza-family fold for the tier scorer", () => {
    expect(normalizeArabicText("أبل")).toBe(normalizeArabicText("ابل"));
    expect(normalizeArabicText("إستقبال")).toBe(normalizeArabicText("استقبال"));
  });
});

describe("relevance tiers (REEA-213 Bet 1)", () => {
  it("head-name match beats buried full coverage beats partial coverage", () => {
    // Query 1 fixtures: the direct phone card, a bundle with the phrase
    // buried, and a single-token cross-category listing.
    expect(relevanceTier("iPhone 17 Pro", "Apple iPhone 17 Pro, 256 GB")).toBe(1);
    expect(relevanceTier("iPhone 17 Pro", "Techpick 4-in-1 Protection Pack for Apple iPhone 17 Pro")).toBe(2);
    expect(relevanceTier("iPhone 17 Pro", "Razer Viper V4 Pro Wireless Gaming Mouse for iPhone")).toBe(3);
  });

  it("Arabic head match reads word-containment and brand-field offsets", () => {
    expect(relevanceTier("غسالة", "غسالة فريش 10 كجم حوض واحد")).toBe(1);
    // غسالة only inside a descriptive phrase → full coverage but buried.
    expect(relevanceTier("غسالة", "Marabu Air Top Color آمن للغسل في غسالة الاطباق")).toBe(2);
  });

  it("metadata-only match lands in the bottom tier", () => {
    // The title answers no token; only the retailer's brand field does.
    expect(relevanceTier("Anker PowerCore", "Power Bank 20100mAh Slim", "Anker Anker")).toBe(4);
  });

  it("zero-match titles stay excluded", () => {
    expect(relevanceTier("iPhone 17 Pro", "Ceramic Mug White")).toBe(0);
  });

  it("an empty query keeps a single flat block", () => {
    expect(relevanceTier("", "Anything at all")).toBe(1);
  });
});

describe("model-extension flag (REEA-213)", () => {
  it("a trailing qualifier extends, a comma/spec boundary does not", () => {
    expect(isModelExtended("iPhone 17 Pro", "Apple iPhone 17 Pro Max 256GB")).toBe(true);
    expect(isModelExtended("iPhone 17 Pro", "Apple iPhone 17 Pro, 256 GB")).toBe(false);
  });

  it("plain category words never extend (Arabic has no Max-suffix ladder)", () => {
    expect(isModelExtended("غسالة", "غسالة فريش 10 كجم حوض واحد")).toBe(false);
  });
});

describe("named-brand signal (REEA-213)", () => {
  it("branded listings beat blank and generic placeholders", () => {
    expect(brandIsNamed("Fresh", "غسالة فريش 10 كجم حوض واحد")).toBe(true);
    expect(brandIsNamed("Non Branded", "غسالة، لعب الاطفال التظاهر")).toBe(false);
    expect(brandIsNamed(undefined, "Ceramic Mug White")).toBe(false);
  });
});

describe("brand-field conflict rule (REEA-487)", () => {
  it("a conflicting merchant field yields to the brand the title shows", () => {
    // Live Quadra shape: the Shopify `Manufacturer` option stamps whole
    // import batches with one stale value; both observed titles carried ACER.
    expect(resolveBrand("ACER", "RAZER HUNTSMAN V3 PRO MINI 60% Analog Optical Esports Keyboard US - Black")).toBe("Razer");
    expect(resolveBrand("ACER", "STEELSERIES ARCTIS NOVA PRO Wireless Gaming Headset - Black")).toBe("SteelSeries");
    // The vendor fallback shape of the same hop carries the store's own name;
    // the title-brand still wins over the disagreement.
    expect(resolveBrand("Prince Computers LLC (1.0 Units - 47.281 KD)", "RAZER HUNTSMAN V3 PRO MINI 60% Analog Optical Esports Keyboard US - Black")).toBe("Razer");
  });

  it("agreeing merchant values are kept, unknown ones stay verbatim when the title is silent", () => {
    // Agreement keeps the curated casing of the merchant value.
    expect(resolveBrand("acer", "Acer Nitro V15 ANV15-41 Gaming Laptop")).toBe("Acer");
    expect(resolveBrand("ASUS", "ASUS TUF Gaming F16 FX607JVR")).toBe("Asus");
    // No curated brand readable from either side → the field stands as-is.
    expect(resolveBrand("Zowie", "S25 XL2566K Gaming Monitor")).toBe("Zowie");
    // Curated field, curated title brand, no conflict: casing only changes.
    expect(resolveBrand("SONY", "Sony WH-CH720N Wireless Headphones")).toBe("Sony");
  });
});
