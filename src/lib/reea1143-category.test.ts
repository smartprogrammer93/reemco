/**
 * REEA-1143 — category-intent ranking + aggregate coverage honesty.
 *
 * AC1: for a category query (`air fryer`, `ps5`, `laptop`, `headphones`) the
 * top 3 cards are class products; accessories, food, games, toys and bags rank
 * below them.
 * AC2: exact-model queries (`fold 7`, `iPhone 17 Pro`) keep the untouched
 * ladder — the accessory demotion is query-class aware.
 * AC3/AC4: every results page states the aggregate run coverage in counts only
 * ("22 stores checked · 1 carries this · 2 failed · 19 empty"), EN+AR, with no
 * new identifiers and no per-store records in the aggregate copy.
 */
import "@/lib/collect/test-cache-dir";
import { describe, expect, it } from "vitest";
import {
  categoryIntent,
  categoryRowClass,
  narrowCategoryLead,
  relevanceTier,
} from "@/lib/relevance";
import { coverageLine } from "@/lib/collect/coverage";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

function hit(over: Partial<SearchHit>): SearchHit {
  // Unique listing URL per fixture: the live chain dedupes one offer per
  // (retailer, listing) before grouping, so two synthetic rows sharing a URL
  // would collapse into one and hide the row under test.
  const url = over.url ?? `https://example.test/${encodeURIComponent(over.title ?? "placeholder")}`;
  return {
    title: "placeholder",
    merchant: "Xcite",
    price: 10,
    currency: "KWD",
    url,
    inStock: true,
    country: "KW",
    ...over,
  };
}

function titlesFor(query: string, hits: SearchHit[]): string[] {
  return groupHits(query, hits).map((p) => p.title);
}

describe("REEA-1143 AC1 — category queries lead with the class product", () => {
  it("air fryer: appliances outrank liners, spray, food and a toy", () => {
    const hits = [
      hit({ title: "Air Fryer Baking Paper Liners 100 Sheets", merchant: "Xcite", price: 0.9 }),
      hit({ title: "Cooking Spray Oil for Air Fryer", merchant: "Jarir", price: 1.2 }),
      hit({ title: "Chicken Popcorn Air Fryer Snack", merchant: "Sultan Center", price: 2 }),
      // Live-caught on the deployed stamp: frozen chips named the class and
      // slipped into #3 before the food marker existed.
      hit({ title: "Mccain Frozen Vegan Airfryer Classique Potato Chips", merchant: "Sultan Center", price: 3 }),
      // Live-caught on the served payload: a seasoning sachet that names the
      // class held a top-3 slot before the seasoning/mix marker existed.
      hit({ title: "Maggi Airfryer Mix Louisiana Buffalo Seasoning", merchant: "Sultan Center", price: 1.5 }),
      hit({ title: "Air Fryer Toy with Light & Sound", merchant: "Danube Home", price: 5 }),
      hit({ title: "Philips Air Fryer, 1700W, 6.2L - Black", merchant: "Xcite", price: 45 }),
      hit({ title: "Xiaomi Air Fryer 6.5L White", merchant: "Eureka", price: 39 }),
      hit({ title: "Nutricook Air Fryer 5.5L NC-AF205 - Black", merchant: "Wibi", price: 32 }),
    ];
    const titles = titlesFor("air fryer", hits);
    const intent = categoryIntent("air fryer")!;
    expect(intent).not.toBeNull();
    expect(titles.slice(0, 3).map((t) => categoryRowClass(intent, t))).toEqual([
      "product",
      "product",
      "product",
    ]);
    // The complement aisle is behind every class product.
    const firstComplement = titles.findIndex((t) => categoryRowClass(intent, t) === "complement");
    const lastProduct = titles.reduce(
      (last, t, i) => (categoryRowClass(intent, t) === "product" ? i : last),
      -1,
    );
    expect(firstComplement).toBeGreaterThan(lastProduct);
    expect(titles.slice(0, 3)).not.toContain("Air Fryer Baking Paper Liners 100 Sheets");
    expect(titles.slice(0, 3)).not.toContain("Air Fryer Toy with Light & Sound");
  });

  it("ps5: console + controllers outrank games, cartridges, cases and bags", () => {
    const hits = [
      hit({ title: "USTM PS5 Cartridge", merchant: "Xcite", price: 2 }),
      hit({ title: "PS5 NBA 2K27 for PlayStation 5", merchant: "Blink", price: 25 }),
      hit({ title: "PS5 Backpack - Console Carrying Case for Sony PlayStation 5", merchant: "Amazon.eg", price: 8 }),
      hit({ title: "PowerA PS5 DualSense Controller Protection Case, 81313", merchant: "Xcite", price: 6 }),
      hit({ title: "PS5 Controller Quick Charger, Dual USB Dock", merchant: "Amazon.eg", price: 3 }),
      // Live-caught on the deployed stamp: the singular "charger" marker
      // missed "Charging Station", so it held #3 above the controllers.
      hit({ title: "Sony PS5 DualSense Charging Station", merchant: "Amazon.eg", price: 9 }),
      hit({ title: "PS5 Call of Duty Modern Warfare 4 for Playstation 5", merchant: "Blink", price: 24 }),
      hit({ title: "PlayStation 5 Console Disc Edition", merchant: "Jarir", price: 150 }),
      hit({ title: "Sony PS5 DualSense Wireless Controller", merchant: "Wibi", price: 22 }),
      hit({ title: "Sony PS5 DualSense Wireless Controller Alpine Green", merchant: "Eureka", price: 23 }),
    ];
    const titles = titlesFor("ps5", hits);
    const intent = categoryIntent("ps5")!;
    expect(intent).not.toBeNull();
    // A platform name is a category, not an exact model: `ps5` is in the class
    // noun list, so the model-identity guard does not turn it into a model query.
    expect(intent.id).toBe("gaming-console");
    // REEA-1140 — Alpine Green is a colourway of the same DualSense card, so
    // this fixture carries TWO class products, not three: the console and the
    // merged controller. Both lead; a complement may follow them.
    expect(titles.slice(0, 2).map((t) => categoryRowClass(intent, t))).toEqual([
      "product",
      "product",
    ]);
    expect(titles.slice(0, 2)).not.toContain("USTM PS5 Cartridge");
    expect(titles.slice(0, 2)).not.toContain("PS5 NBA 2K27 for PlayStation 5");
    // The Alpine Green listing folded into the base controller card.
    expect(titles).toContain("Sony PS5 DualSense Wireless Controller");
    expect(titles).not.toContain("Sony PS5 DualSense Wireless Controller Alpine Green");
  });

  it("laptop and headphones lead with their class products", () => {
    const laptopTitles = titlesFor("laptop", [
      hit({ title: "Laptop Backpack 15.6 inch Waterproof", merchant: "Xcite", price: 8 }),
      hit({ title: "HP Laptop, AMD Ryzen 5, 8GB RAM, 512GB SSD, 15.6-Inch", merchant: "Xcite", price: 210 }),
      hit({ title: "Dell Laptop Pro 15 Essential PV15250 - i7 - 8GB", merchant: "Zayoom", price: 260 }),
      hit({ title: "Lenovo IdeaPad Slim 3 Laptop 15IRH10", merchant: "Blink", price: 175 }),
      hit({ title: "Gamvity S2 Triple Laptop Screen Extender 14 Inch", merchant: "Quadra Stores", price: 40 }),
    ]);
    const laptopIntent = categoryIntent("laptop")!;
    expect(laptopTitles.slice(0, 3).map((t) => categoryRowClass(laptopIntent, t))).toEqual([
      "product",
      "product",
      "product",
    ]);

    const headphoneTitles = titlesFor("headphones", [
      hit({ title: "Headphone Case Hard Shell Travel Bag", merchant: "Xcite", price: 4 }),
      hit({ title: "JBL Tune 780NC Wireless Over-Ear Headphones", merchant: "Blink", price: 45 }),
      hit({ title: "Sony WH-CH720N Noise Canceling Wireless Headphones", merchant: "Blink", price: 39 }),
      hit({ title: "JBL Tune 530BT Wireless Over-Ear Headphones Lavender", merchant: "Eureka", price: 20 }),
      hit({ title: "Replacement Earpads Cushion for Headphones", merchant: "Jarir", price: 3 }),
    ]);
    const headphoneIntent = categoryIntent("headphones")!;
    expect(headphoneTitles.slice(0, 3).map((t) => categoryRowClass(headphoneIntent, t))).toEqual([
      "product",
      "product",
      "product",
    ]);
  });

  it("category synonyms answer the class query (compound spellings + platform names)", () => {
    // The tokenizer cannot fold "Airfryer" into "air fryer" or "PlayStation 5"
    // into "ps5"; the category bridge rescues exactly the tier-0 class product
    // and leaves every higher rung alone.
    expect(relevanceTier("air fryer", "Philips Airfryer Essential 6.2L")).toBe(1);
    expect(relevanceTier("ps5", "PlayStation 5 Console Disc Edition")).toBe(1);
    // A buried full match keeps the rung it earned (never re-tiered).
    expect(relevanceTier("air fryer", "Premium Baking Paper Liners Compatible with Air Fryer")).toBe(2);
  });
});

describe("REEA-1143 AC2 — exact-model queries keep the untouched ladder", () => {
  it("fold 7 is not a category query and its accessory stays a legitimate card", () => {
    expect(categoryIntent("fold 7")).toBeNull();
    expect(categoryIntent("iphone 17 pro")).toBeNull();
    const titles = titlesFor("fold 7", [
      hit({ title: "Samsung Galaxy Z Fold7, 5G, 12 GB RAM", merchant: "Xcite", price: 380 }),
      hit({ title: "for Samsung Z Fold 7 Case Clear, Compatible with MagSafe", merchant: "Amazon.eg", price: 2 }),
      hit({ title: "Uniq Hybrid MagSafe Case for Samsung Galaxy Z Fold 7", merchant: "Wibi", price: 5 }),
    ]);
    expect(titles[0]).toContain("Fold7");
    // The cases still render (the query can be about them); the phone leads.
    expect(titles).toContain("for Samsung Z Fold 7 Case Clear, Compatible with MagSafe");
  });

  it("iPhone 17 Pro leads with the phone, not the case", () => {
    // Live shape: the phone card carries a Kuwait-primary retailer too, so
    // the retailer round-robin cannot lift a case-only card above it.
    const titles = titlesFor("iphone 17 pro", [
      hit({ title: "Apple iPhone 17 Pro Silicone Case with MagSafe", merchant: "Wibi", price: 2 }),
      hit({ title: "Apple iPhone 17 Pro 256GB Silver", merchant: "Xcite", price: 389 }),
    ]);
    expect(titles[0]).toContain("iPhone 17 Pro");
    expect(titles[0]).not.toContain("Case");
    // The accessory is still rendered — exact-model queries never drop it.
    expect(titles).toContain("Apple iPhone 17 Pro Silicone Case with MagSafe");
  });
});

describe("REEA-1143 serve-time guard — stored snapshots re-head, idempotently", () => {
  it("re-heads a pre-fix stored snapshot and is stable on a second pass", () => {
    const stored = [
      { title: "Air Fryer Baking Paper Liners 100 Sheets" },
      { title: "Cooking Spray Oil for Air Fryer" },
      { title: "Philips Air Fryer, 1700W, 6.2L - Black" },
      { title: "Xiaomi Air Fryer 6.5L White" },
    ];
    const once = narrowCategoryLead("air fryer", stored);
    expect(once.slice(0, 2).map((p) => p.title)).toEqual([
      "Philips Air Fryer, 1700W, 6.2L - Black",
      "Xiaomi Air Fryer 6.5L White",
    ]);
    expect(narrowCategoryLead("air fryer", once)).toEqual(once);
  });

  it("an exact-model snapshot passes through byte-for-byte", () => {
    const stored = [
      { title: "for Samsung Z Fold 7 Case Clear" },
      { title: "Samsung Galaxy Z Fold7 5G 256GB" },
    ];
    expect(narrowCategoryLead("fold 7", stored)).toEqual(stored);
  });

  it("an accessory-only answer set keeps its stored order (no fabricated lead)", () => {
    const stored = [{ title: "Air Fryer Liners" }, { title: "Air Fryer Spray" }];
    expect(narrowCategoryLead("air fryer", stored)).toEqual(stored);
  });
});

describe("REEA-1143 AC3/AC4 — aggregate coverage on thin and zero pages", () => {
  // The panadol live shape: 22 lanes queried, 1 answered (Danube Home), 2
  // failed (Amazon.eg 503, Lulu blocked) and 19 answered with nothing.
  const panadol = [
    { merchant: "Danube Home", hits: 4 },
    { merchant: "Xcite", hits: 0 },
    { merchant: "Blink", hits: 0 },
    { merchant: "Eureka", hits: 0 },
    { merchant: "Sultan Center", hits: 0 },
    { merchant: "Jarir", hits: 0 },
    { merchant: "Quadra Stores", hits: 0 },
    { merchant: "Switch", hits: 0 },
    { merchant: "Wibi", hits: 0 },
    { merchant: "Astore", hits: 0 },
    { merchant: "Zayoom", hits: 0 },
    { merchant: "Yousifi", hits: 0 },
    { merchant: "Aster Pharmacy", hits: 0 },
    { merchant: "Nahdi", hits: 0 },
    { merchant: "Alghanim Electronics", hits: 0 },
    { merchant: "BinSina", hits: 0 },
    { merchant: "Nest", hits: 0 },
    { merchant: "Bomai", hits: 0 },
    { merchant: "Hobby Center", hits: 0 },
    { merchant: "YasO", hits: 0 },
    { merchant: "Amazon.eg", hits: 0, error: "HTTP 503" },
    { merchant: "Lulu Hypermarket", hits: 0, error: "blocked: Cloudflare 403/challenge" },
  ];

  const panadolProduct = {
    productId: "panadol",
    title: "Panadol Extra Pain Relief Tablets 24tablets",
    brand: "",
    offers: [{ merchant: "Danube Home", price: 0.47, currency: "KWD", url: "https://d.example/p", inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
  };

  it("a thin page states the scale before the named lanes (EN)", () => {
    const line = coverageLine(panadol, "en", [panadolProduct]);
    // Aggregate copy: counts only, no per-store records (AC4).
    expect(line.startsWith("22 stores checked · 1 carries this · 2 failed · 19 empty.")).toBe(true);
    // The shipped named sentences still follow.
    // REEA-1207 AC 7B-4 — a "blocked:" cause is named in the UNREACHABLE
    // sentence, not as a plain "no response": the lane was dispatched and
    // produced nothing usable, which is not the same as answering no match.
    expect(line).toContain("Unreachable: Lulu Hypermarket.");
    expect(line).toContain("No response from Amazon.eg.");
    expect(line).toContain("Prices from Danube Home.");
    // The aggregate clause names no retailer.
    const aggregate = line.split(". ")[0];
    expect(aggregate).not.toMatch(/Danube|Amazon|Lulu|Xcite/);
  });

  it("states the same facts in Arabic, with Arabic count agreement", () => {
    const line = coverageLine(panadol, "ar", [panadolProduct]);
    expect(line.startsWith("تم فحص 22 متجرًا · متجر واحد يوفّر هذا · لم يستجب 2 · 19 بلا مطابقة.")).toBe(true);
    expect(line).toContain("الأسعار من Danube Home.");
  });

  it("an exact-model query says 'carries this exact model'", () => {
    const line = coverageLine(
      [
        { merchant: "Xcite", hits: 1 },
        { merchant: "Blink", hits: 0 },
      ],
      "en",
      [
        {
          productId: "fold7",
          title: "Samsung Galaxy Z Fold7 5G 256GB",
          brand: "Samsung",
          offers: [{ merchant: "Xcite", price: 380, currency: "KWD", url: "https://x/1", inStock: true }],
          coupons: [],
          variations: [],
          alternatives: [],
        },
      ],
      undefined,
      "fold 7",
    );
    expect(line).toContain("2 stores checked · 1 carries this exact model");
    expect(line).toContain("1 empty");
    expect(line).not.toContain("carries this ·");
  });

  it("a platform category with a digit says 'carry this', not 'exact model'", () => {
    // Live-caught on the served ps5 page: `ps5` carries a model-shaped digit
    // token but names a class, so the aggregate must not claim "exact model".
    const line = coverageLine(
      [
        { merchant: "Wibi", hits: 3 },
        { merchant: "Eureka", hits: 1 },
        { merchant: "Blink", hits: 0 },
      ],
      "en",
      [
        {
          productId: "ps5-controller",
          title: "Sony PS5 DualSense Wireless Controller",
          brand: "Sony",
          offers: [{ merchant: "Wibi", price: 22, currency: "KWD", url: "https://x/2", inStock: true }],
          coupons: [],
          variations: [],
          alternatives: [],
        },
      ],
      undefined,
      "ps5",
    );
    expect(line).toContain("3 stores checked · 2 carry this · 1 empty");
    expect(line).not.toContain("exact model");
  });

  it("a zero-row page keeps the failure/empty half and the aggregate scale", () => {
    const line = coverageLine(
      [
        { merchant: "Aster Pharmacy", hits: 0, error: "no response within budget" },
        { merchant: "Nahdi", hits: 0 },
        { merchant: "BinSina", hits: 0, error: "no response within budget" },
        { merchant: "Danube Home", hits: 4 },
      ],
      "en",
      [],
    );
    // REEA-1247 AC1 — Danube Home's four rows never reached the shelf, so the
    // zero page says "none carry this" and names the similar-items lane.
    expect(line.startsWith("4 stores checked · none carry this · 1 store had similar items, none matched · 2 failed · 1 empty.")).toBe(true);
    expect(line).toContain("No response from Aster Pharmacy and BinSina.");
    expect(line).toContain("No match at Nahdi.");
  });

  it("an empty run renders no coverage line (no flicker)", () => {
    expect(coverageLine([], "en")).toBe("");
    expect(coverageLine([], "ar")).toBe("");
  });
});
