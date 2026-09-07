/**
 * REEA-114 — live query-time collection tests: hit extraction per retailer
 * contract, cross-retailer grouping, and the bounded fan-out with injected
 * fetch (one failing retailer must not lose the others' offers).
 */
import { describe, expect, it } from "vitest";
import { PER_RETAILER_TIMEOUT_MS } from "@/lib/collect/types";
import {
  amazonEgHits,
  blinkHits,
  collectLiveResults,
  collectLiveResultsStaged,
  eurekaHits,
  groupHits,
  jarirHits,
  LIVE_SEARCH_BUDGET_MS,
  LIVE_SEARCH_HITS_PER_PAGE,
  LIVE_SEARCH_TIMEOUT_MS,
  resetDiscoveryCache,
  sultanCenterHits,
  xciteHits,
  type SearchHit,
} from "@/lib/collect/live-search";
import {
  canonicalFields,
  canonicalKey,
  compatibleFields,
  gradeBadgeLabel,
} from "@/lib/collect/canonical-product";
import { isAccessoryTitle } from "@/lib/relevance";

describe("hit parsers", () => {
  it("xciteHits keeps scored hits with /p product URLs", () => {
    const payload = {
      results: [
        {
          hits: [
            { name: "Samsung Galaxy S26 Ultra 256GB", slug: "sg-s26u", price: 399, currency: "KWD", inStock: true, unmodifiedPrice: 429 },
            { name: "Unrelated Dock", slug: "dock", price: 9, currency: "KWD", inStock: true },
            { name: "Samsung Galaxy S26 Edge", slug: "s26e", price: 299, inStock: false },
          ],
        },
      ],
    };
    const hits = xciteHits(payload, "samsung");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ merchant: "Xcite", url: "https://www.xcite.com/sg-s26u/p", price: 399, wasPrice: 429 });
    expect(hits[1].inStock).toBe(false);
  });

  it("blinkHits reads Shopify variants", () => {
    const hits = blinkHits(
      { products: [{ title: "Samsung Galaxy S26", handle: "sg-s26", variants: [{ price: "350.00", available: true }] }] },
      "samsung galaxy s26",
    );
    expect(hits[0]).toMatchObject({ merchant: "Blink", price: 350, url: "https://blink.com.kw/products/sg-s26", inStock: true });
  });

  it("eurekaHits maps clprc/lprc and stock quantity", () => {
    const hits = eurekaHits(
      { hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9001", clprc: 380, lprc: 410, avaqt: 4 }] },
      "samsung",
    );
    // REEA-136 guardrail: canonical store route /products/details/<id>,
    // not the hard-404-ing /en/<Title>/<id> shape.
    expect(hits[0]).toMatchObject({
      price: 380,
      wasPrice: 410,
      inStock: true,
      url: "https://www.eureka.com.kw/products/details/9001",
    });
  });

  it("jarirHits reads Constructor metadata and keeps SAR", () => {
    const hits = jarirHits(
      { response: { results: [{ data: { url: "p/s26", price: "1499", metadata: { name: "Samsung Galaxy S26 Ultra" } } }] } },
      "samsung",
    );
    expect(hits[0]).toMatchObject({ merchant: "Jarir", price: 1499, currency: "SAR", url: "https://www.jarir.com/p/s26" });
  });

  it("jarirHits reads the metadata brand through the shared candidate chain (REEA-195)", () => {
    // Adapter symmetry: jarir is the only JSON contract that nests `brand`
    // inside metadata — the Arabic index ships it populated and the card's
    // brand line must not go blank for that reason.
    const hits = jarirHits(
      { response: { results: [{ data: { url: "p/ap-airpods4", price: 59, metadata: { name: "سماعة أبل AirPod Slic 4 Generate", brand: "Apple" } } }] } },
      "سماعة أبل",
    );
    expect(hits[0]).toMatchObject({ brand: "Apple", title: "سماعة أبل AirPod Slic 4 Generate" });
  });

  it("Arabic brand queries survive the English-index coverage gates (REEA-195)", () => {
    // Observed live: xcite's en index answers the Arabic query with Latin
    // titles. Plain cross-script substring coverage drops every one of them,
    // leaving only Jarir's Arabic listings — the QA-reported generic-speaker
    // result. The alias bridge keeps the branded hit and still cuts noise.
    const hits = xciteHits(
      {
        results: [
          {
            hits: [
              { name: "Apple Airpods 4 - White", slug: "apple-airpods-4-white", price: 34.9, currency: "KWD", inStock: true },
              { name: "Anker PowerCore 20100 mAh", slug: "anker-powercore", price: 15, currency: "KWD", inStock: true },
            ],
          },
        ],
      },
      "سماعة أبل",
    );
    expect(hits.map((h) => h.title)).toEqual(["Apple Airpods 4 - White"]);
  });

  it("Arabic brand queries lead with the branded offers (REEA-195)", () => {
    // Same-script filler out-scores the branded device in the symmetric fit
    // score; the brand-match partition moves the Apple offer in front while
    // everything keeps its relative order behind it. One merchant on both
    // rows keeps the retailer round-robin out of the ordering question.
    const hits: SearchHit[] = [
      { title: "سماعة القرآن الكريم للاطفال", merchant: "Jarir", country: "SA", price: 299, currency: "SAR", url: "https://www.jarir.com/arabic-books-675545.html", inStock: true },
      { title: "Apple Airpods 4 - White", merchant: "Jarir", country: "SA", brand: "Apple", price: 34.9, currency: "SAR", url: "https://www.jarir.com/p/ap-airpods4", inStock: true },
    ];
    const products = groupHits("سماعة أبل", hits);
    expect(products[0].title).toBe("Apple Airpods 4 - White");
    expect(products[0].brand).toBe("Apple");
    expect(products[1].title).toBe("سماعة القرآن الكريم للاطفال");
  });

  it("jarirHits keeps verbose live index titles on one-word brand queries (REEA-137)", () => {
    // Fixture trimmed from the real Constructor answer for "samsung": every
    // genuine hit carries a spec tail. Under the old symmetric title score
    // those titles fell below MIN_SCORE and the retailer silently vanished
    // from samsung results.
    const hits = jarirHits(
      {
        response: {
          results: [
            { data: { url: "samsung-galaxy-s25-ultra-256-titanium-black.html", price: 4399, metadata: { name: "Samsung Galaxy S25 Ultra, 256 GB, 12 GB RAM, Titanium Black, 5G, Snapdragon 8 Elite" } } },
            { data: { url: "anker-powercore.html", price: 10, metadata: { name: "Anker PowerCore 20100" } } },
          ],
        },
      },
      "samsung",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].merchant).toBe("Jarir");
  });

  it("sultanCenterHits maps product_list rows to direct store URLs", () => {
    // Fixture trimmed from the live mobile/api/search answer for "air fryer".
    const payload = {
      status: "1",
      products: {
        product_list: [
          {
            id: "79858",
            name: "Midea Air Fryer 11L MAD-110D2APK",
            sku: "303553260",
            price: "18.9900",
            spclprice: "",
            is_in_stock: "1",
            stock_quantity: "9",
            currencysymbol: "KD",
            slug: "midea-air-fryer-11l-black-11-l",
          },
          {
            id: "7",
            name: "Maggi Air Fryer Hot Buffalo Mix",
            price: "0.5000",
            spclprice: "0.4500",
            is_in_stock: "1",
            currencysymbol: "KD",
            slug: "maggi-air-fryer-hot-buffalo-mix-65-g",
          },
          { id: "8", name: "No Slug Item", price: "2.0000" },
        ],
      },
    };
    const hits = sultanCenterHits(payload, "air fryer");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      merchant: "Sultan Center",
      price: 18.99,
      currency: "KWD",
      url: "https://www.sultan-center.com/product/midea-air-fryer-11l-black-11-l",
      inStock: true,
    });
    // spclprice is the running promo: cheaper price wins, regular kept as wasPrice.
    expect(hits[1]).toMatchObject({ price: 0.45, wasPrice: 0.5 });
  });

  it("sultanCenterHits marks is_in_stock 0 as out of stock", () => {
    const hits = sultanCenterHits(
      { products: { product_list: [{ name: "Air Fryer Basket", slug: "basket", price: "3.0000", is_in_stock: "0" }] } },
      "air fryer",
    );
    expect(hits[0].inStock).toBe(false);
  });

  it("amazonEgHits parses cards with Arabic-Indic prices", () => {
    const html =
      'x data-component-type="s-search-result" <h2 aria-label="Samsung Galaxy S26 Ultra"><span>. </span></h2> ' +
      '<span class="a-offscreen">EGP ١٬٤٩٩٫٠٠</span><a href="/dp/B1234567">y</a> z';
    const hits = amazonEgHits(html, "samsung");
    expect(hits[0]).toMatchObject({ merchant: "Amazon.eg", price: 1499, currency: "EGP", url: "https://www.amazon.eg/dp/B1234567" });
  });
});

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "Samsung Galaxy S26 Ultra",
    merchant: "Xcite",
    price: 399,
    currency: "KWD",
    url: "https://xcite.example/p",
    inStock: true,
    country: "KW",
    ...over,
  };
}

describe("groupHits", () => {
  it("merges the same title across retailers, cheapest offer first", () => {
    const products = groupHits("samsung", [
      hit({ merchant: "Jarir", price: 410, url: "https://jarir.example/s26" }),
      hit({ merchant: "Amazon.eg", price: 390, url: "https://amz.example/dp/1", currency: "EGP", inStock: false }),
      hit({ merchant: "Xcite", price: 399 }),
      hit({ title: "Samsung Monitor Odyssey", merchant: "Blink", price: 200, url: "https://blink.example/2" }),
    ]);
    expect(products).toHaveLength(2);
    const s26 = products.find((p) => p.title === "Samsung Galaxy S26 Ultra")!;
    const monitor = products.find((p) => p.title === "Samsung Monitor Odyssey")!;
    // REEA-167 §2: the canonical offer list ascends by price — cheapest
    // first; purchasable offers only break ties.
    expect(s26.offers.map((o) => o.merchant)).toEqual(["Amazon.eg", "Xcite", "Jarir"]);
    expect(s26.alternatives.map((a) => a.title)).toContain("Samsung Monitor Odyssey");
    expect(monitor.offers).toHaveLength(1);
    // Real collection timestamp, not a computed offset — chips age honestly.
    expect(Date.parse(s26.scrapedAt!)).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - Date.parse(s26.scrapedAt!)).toBeLessThan(5_000);
  });

  it("REEA-168: one canonical view for two title spellings, union of offers, cheapest first", () => {
    const products = groupHits("galaxy z fold7 256gb silver", [
      hit({
        title: "Samsung Galaxy Z Fold7 Phone - Silver",
        merchant: "Xcite",
        price: 494.9,
        url: "https://xcite.example/fold7-phone",
      }),
      hit({
        title: "Samsung Galaxy Z Fold7 256GB 12GB Ram 5G Silver",
        merchant: "Xcite",
        price: 429.9,
        url: "https://xcite.example/fold7-256",
      }),
      hit({
        title: "Samsung Galaxy Z Fold7, 256 GB, 12 GB RAM, Silver Shadow, 5G, Snapdragon 8 Elite",
        merchant: "Jarir",
        price: 7699,
        currency: "SAR",
        url: "https://jarir.example/fold7",
      }),
    ]);
    // One canonical row, not split pages (REEA-167 acceptance 1/4): three
    // live listings of one device, one merged view.
    expect(products).toHaveLength(1);
    const fold = products[0];
    // REEA-192: one row per retailer at that retailer's best matched-product
    // offer — Xcite's two listings fold into its cheapest one.
    expect(fold.offers.map((o) => o.price)).toEqual([429.9, 7699]);
    expect(fold.offers.map((o) => o.merchant)).toEqual(["Xcite", "Jarir"]);
    // Canonical title = member title with the fewest tokens → stable slug.
    expect(fold.title).toBe("Samsung Galaxy Z Fold7 Phone - Silver");
    expect(fold.productId).toBe("samsung-galaxy-z-fold7-phone-silver");
  });

  it("REEA-192: fold7 live case — device card carries phone offers only, badge row cheapest phone offer, accessory cards own their rows", () => {
    // Mirrors the live q=fold7 answers: three phone listings across
    // Xcite/Eureka/Jarir plus accessory-class listings that previously folded
    // into the phone card and pushed the SAR 69 case price under the badge.
    const products = groupHits("fold7", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 429.9, url: "https://xcite.example/fold7-black" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone", merchant: "Eureka", price: 494.9, url: "https://eureka.example/fold7" }),
      hit({ title: "Samsung Galaxy Z Fold7 256GB 12GB Ram 5G Black", merchant: "Jarir", price: 7699, currency: "SAR", url: "https://jarir.example/fold7" }),
      hit({ title: "Araree Aero Flex Electronic Gadgets Cases For Samsung Galaxy Z Fold7", merchant: "Jarir", price: 69, currency: "SAR", url: "https://jarir.example/aero-case" }),
      hit({ title: "OtterBox Defender Series XT Cases For Samsung Galaxy Z Fold7", merchant: "Jarir", price: 99, currency: "SAR", url: "https://jarir.example/otter-case" }),
      hit({ title: "Panzerglass Screen Protector Film For Galaxy Z Fold7 PG68903", merchant: "Amazon.eg", price: 149, currency: "EGP", url: "https://amazon.example/dp/x1" }),
    ]);
    const device = products.find((p) => !isAccessoryTitle(p.title))!;
    // Phone-class offers only; one row per retailer at its best phone price;
    // cheapest phone offer first is what the LOWEST LISTED PRICE badge reads.
    expect(device.offers.map((o) => o.price)).toEqual([429.9, 494.9, 7699]);
    expect(device.offers.map((o) => o.merchant)).toEqual(["Xcite", "Eureka", "Jarir"]);
    // Accessory listings keep their own cards (REEA-180 Rule 2 tiering puts
    // them under the devices container); the case never dilutes the phone set.
    const accessories = products.filter((p) => isAccessoryTitle(p.title));
    expect(accessories.length).toBeGreaterThan(0);
    expect(accessories.every((p) => p.offers.every((o) => o.price < Math.min(...device.offers.map((x) => x.price))))).toBe(true);
  });

  it("REEA-192: Arabic accessory markers classify the same way (كفر / جراب)", () => {
    const products = groupHits("fold7", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 429.9, url: "https://xcite.example/fold7-black" }),
      hit({ title: "جراب سامسونج جلاكسي Z Fold7", merchant: "Jarir", price: 59, currency: "SAR", url: "https://jarir.example/jirab" }),
    ]);
    expect(products).toHaveLength(2);
    const device = products.find((p) => !isAccessoryTitle(p.title))!;
    const cover = products.find((p) => isAccessoryTitle(p.title))!;
    expect(device.offers.map((o) => o.price)).toEqual([429.9]);
    expect(cover.offers.map((o) => o.price)).toEqual([59]);
  });

  it("REEA-192: one row per retailer at its best matched-product offer", () => {
    const products = groupHits("fold7", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 429.9, url: "https://xcite.example/a" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 460, url: "https://xcite.example/b" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Jarir", price: 455, currency: "SAR", url: "https://jarir.example/c" }),
    ]);
    expect(products).toHaveLength(1);
    expect(products[0].offers.map((o) => `${o.merchant}:${o.price}`)).toEqual(["Xcite:429.9", "Jarir:455"]);
  });

  it("REEA-168: both example spellings reduce to one canonical key", () => {
    // Worked example from the spec (§1 step 4): brand|model_line|storage|
    // color|grade, joined with "|", fields in that exact order.
    expect(canonicalKey("Samsung Galaxy Z Fold7 Phone Silver Renewed Grade B")).toBe(
      "samsung|galaxy z fold7|silver|renewed-grade-b",
    );
    // Worked example from the spec (§1 step 4): the verbose retailer title
    // lands on the same tuple as the short one; RAM restatements are the
    // only noise stripped around it.
    expect(canonicalFields("Samsung Galaxy Z Fold7 Phone Silver")).toMatchObject({
      brand: "samsung",
      modelLine: "galaxy z fold7",
      color: "silver",
      grade: "new",
    });
    expect(canonicalFields("Samsung Galaxy Z Fold7, 256 GB, 12 GB RAM, Silver Shadow, 5G, Snapdragon 8 Elite")).toMatchObject({
      brand: "samsung",
      modelLine: "galaxy z fold7",
      storage: "256gb",
      color: "silver",
      grade: "new",
    });
    const a = canonicalFields("Samsung Galaxy Z Fold7 Phone Silver");
    const b = canonicalFields("Samsung Galaxy Z Fold7, 256 GB, 12 GB RAM, Silver Shadow, 5G, Snapdragon 8 Elite");
    expect(compatibleFields(a, b)).toBe(true); // partial-match rule (§1)
    // Both live example slugs decode to compatible field sets.
    expect(
      compatibleFields(
        canonicalFields("samsung galaxy z fold7 5g 256gb phone silver"),
        canonicalFields("samsung galaxy z fold7 256gb 12gb ram 5g silver"),
      ),
    ).toBe(true);
  });

  it("REEA-205: inch-quote noise collapses the iPhone live pair into one card", () => {
    // Live board pair for "iphone 17 pro max": Xcite quotes the inch sign,
    // Eureka spells it out and carries a network token — one device must
    // render ONE card, cheapest offer leading (the LOWEST LISTED PRICE row).
    const products = groupHits("iphone 17 pro max", [
      hit({ title: 'Apple iPhone 17 Pro Max 6.9" 256GB - Silver', merchant: "Xcite", price: 429.9, url: "https://xcite.example/17pm-silver" }),
      hit({ title: "Apple iPhone 17 Pro Max 6.9 inch 256GB 5G Silver", merchant: "Eureka", price: 379.9, url: "https://eureka.example/17pm" }),
    ]);
    expect(products).toHaveLength(1);
    expect(products[0].offers.map((o) => [o.merchant, o.price])).toEqual([
      ["Eureka", 379.9],
      ["Xcite", 429.9],
    ]);
  });

  it("REEA-205: quote marks fold like separators in every encoding flavour", () => {
    // Straight inch sign, right curly quote and the prime all tokenize to
    // the same size token as the spelled "inch".
    const spelled = canonicalKey("Apple iPhone 17 Pro Max 6.9 inch 256GB Silver");
    expect(canonicalKey('Apple iPhone 17 Pro Max 6.9" 256GB - Silver')).toBe(spelled);
    expect(canonicalKey("Apple iPhone 17 Pro Max 6.9\u201D 256GB Silver")).toBe(spelled);
    expect(canonicalKey("Apple iPhone 17 Pro Max 6.9\u2033 256GB Silver")).toBe(spelled);
    // Over-merge guard survives the folding: capacities stay separate cards.
    expect(
      compatibleFields(
        canonicalFields('Apple iPhone 17 Pro Max 6.9" 256GB - Silver'),
        canonicalFields("Apple iPhone 17 Pro Max 6.9 inch 512GB Silver"),
      ),
    ).toBe(false);
  });

  it("REEA-205: Arabic titles merge on separator noise, capacities discriminate", () => {
    // Arabic-script listings of the same device fold across comma/dash
    // noise; an Arabic-unit capacity ("جيجابايت") keeps discriminating, so
    // 512GB never rides the 256GB card.
    const products = groupHits("آيفون 17 برو ماكس", [
      hit({ title: "أبل آيفون 17 برو ماكس 256 جيجابايت فضي", merchant: "Jarir", price: 410, url: "https://jarir.example/ar1" }),
      hit({ title: "أبل آيفون 17 برو ماكس, 256 جيجابايت - فضي", merchant: "Xcite", price: 429.9, url: "https://xcite.example/ar2" }),
      hit({ title: "أبل آيفون 17 برو ماكس 512 جيجابايت فضي", merchant: "Eureka", price: 459.9, url: "https://eureka.example/ar3" }),
    ]);
    expect(products).toHaveLength(2);
    // Cheapest group leads with both 256GB listings inside it.
    expect(products[0].offers.map((o) => o.merchant)).toEqual(["Jarir", "Xcite"]);
    expect(products[1].offers).toHaveLength(1);
  });

  it("REEA-168: over-merge guards keep distinct variants separate (§3)", () => {
    const base = canonicalFields("Samsung Galaxy Z Fold7 Phone Silver");
    expect(compatibleFields(base, canonicalFields("Samsung Galaxy Z Fold7 Phone Gray"))).toBe(false); // color
    expect(compatibleFields(base, canonicalFields("Samsung Galaxy S25 Phone Silver"))).toBe(false); // model line
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Flip7 Phone Silver"),
      ),
    ).toBe(false); // fold ≠ flip
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Fold7 Phone Gray"),
      ),
    ).toBe(false); // gray ≠ silver
    const renewed = canonicalFields("Samsung Galaxy Z Fold7 Phone Silver Renewed Grade B");
    expect(compatibleFields(base, renewed)).toBe(false); // grade is significant
    expect(renewed.grade).toBe("renewed-grade-b");
    expect(gradeBadgeLabel(renewed.grade)).toBe("Renewed Grade B");
    // Storage restatements and RAM qualify: 512GB never joins the 256GB key;
    // a subset key (no colour yet) joins the matching group — never forks it.
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver 512 GB"),
      ),
    ).toBe(true); // subset (missing storage) merges
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver 256 GB"),
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver 512 GB"),
      ),
    ).toBe(false); // present fields must agree
    expect(compatibleFields(canonicalFields("Samsung Galaxy Z Fold7"), base)).toBe(true);
  });

  it("REEA-168/169: color discriminates inside the merged offer list", () => {
    // Board note on REEA-169: on the Silver page the ranked list holds only
    // Silver units — black/Jet Black units form their own labeled view, and
    // colorless listings keep joining through the partial-match rule.
    const products = groupHits("galaxy z fold7 silver", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone", merchant: "Blink", price: 460, url: "https://blink.example/seed" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Silver", merchant: "Eureka", price: 494.9, url: "https://eureka.example/silver" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Silver", merchant: "Xcite", price: 429.9, url: "https://xcite.example/silver" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Jet Black", merchant: "Jarir", price: 455, url: "https://jarir.example/black" }),
    ]);
    expect(products).toHaveLength(2);
    // Canonical title of the Silver view: fewest tokens among its members —
    // the colorless seed spelling.
    const silver = products.find((p) => p.title === "Samsung Galaxy Z Fold7 Phone")!;
    // Seed merges the Silver offers in (partial-match + field seeding), ranked
    // cheapest-first; the Jet Black unit never enters this list.
    expect(silver.offers.map((o) => o.price)).toEqual([429.9, 460, 494.9]);
    const black = products.find((p) => p.title === "Samsung Galaxy Z Fold7 Phone Jet Black")!;
    expect(black.offers).toHaveLength(1);
    // Jet Black collapses to base black without polluting the model line.
    expect(canonicalFields("Samsung Galaxy Z Fold7 Phone Jet Black").modelLine).toBe("galaxy z fold7");
    // Accessory listings stay out of the device's offer list (REEA-169 f1):
    // the accessory noun keeps the variant label distinct.
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Fold7 Case"),
      ),
    ).toBe(false);
  });
});

describe("collectLiveResults", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  it("collects from every retailer and survives one failure", async () => {
    const { products, notes } = await collectLiveResults("samsung", {
      fetchImpl: async (url) => {
        if (url.includes("blink.com.kw")) throw new Error("blink down");
        if (url.includes("xcite.com")) {
          return jsonResponse({
            results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }],
          });
        }
        if (url.includes("cnstrc.com") || url === "https://www.jarir.com/") {
          if (url.endsWith("jarir.com/")) {
            return new Response('x searchProviderKeys "key_test123456" y', { headers: { "content-type": "text/html" } });
          }
          return jsonResponse({ response: { results: [{ data: { url: "p/s26", price: 1499, metadata: { name: "Samsung Galaxy S26 Ultra" } } }] } });
        }
        if (url.endsWith("eureka.com.kw/")) {
          // Realistic Eureka shape: Algolia app ids are upper-case in the
          // wild ("5GPHMAA239" on the live homepage), so fixtures must be.
          return new Response('<input id="cky" value="A1B2C3D4"><input id="srcapk" value="keyA1b2c3">', { headers: { "content-type": "text/html" } });
        }
        if (url.includes("algolia.net")) {
          return jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9001", clprc: 380, avaqt: 2 }] });
        }
        if (url.includes("sultan-center.com")) {
          return jsonResponse({
            status: "1",
            products: { product_list: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: "385.0000", is_in_stock: "1", currencysymbol: "KD" }] },
          });
        }
        return new Response('data-component-type="s-search-result" <h2 aria-label="Samsung Galaxy S26 Ultra"></h2><span class="a-offscreen">EGP 1,499</span><a href="/dp/B1234567">z</a>');
      },
    });
    expect(notes.some((n) => n.error === "blink down")).toBe(true);
    expect(products).toHaveLength(1);
    // Same exact title across retailers → one card carrying every live offer.
    expect(products[0].offers.length).toBeGreaterThanOrEqual(5);
    const merchants = new Set(products[0].offers.map((o) => o.merchant));
    expect(merchants.size).toBeGreaterThanOrEqual(5);
    // AC-1/AC-2 guard: the grocery + electronics depth merchants ship on the
    // same live path as the incumbents.
    expect(merchants.has("Eureka")).toBe(true);
    expect(merchants.has("Sultan Center")).toBe(true);
  });

  it("caches only the hop; offer queries re-run on every call (REEA-141)", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_cached01" y', { headers: { "content-type": "text/html" } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="APPC9"><input id="srcapk" value="keyCkeyC1">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("cnstrc.com")) {
        return jsonResponse({ response: { results: [{ data: { url: "p/s26", price: 1499, metadata: { name: "Samsung Galaxy S26 Ultra" } } }] } });
      }
      if (url.includes("algolia.net")) {
        return jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9001", clprc: 380, avaqt: 2 }] });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({ results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }] });
      }
      return jsonResponse({});
    };

    await collectLiveResults("samsung", { fetchImpl });
    const afterFirst = calls.length;
    await collectLiveResults("samsung", { fetchImpl });

    const homeRuns = calls.filter((u) => u === "https://www.jarir.com/" || u === "https://www.eureka.com.kw/").length;
    expect(homeRuns).toBe(2); // one discovery chain total, not one per call
    expect(afterFirst).toBeGreaterThan(homeRuns);
    // Offers stay live: every call re-queries each retailer's search endpoint.
    expect(calls.filter((u) => u.includes("cnstrc.com") || u.includes("algolia.net"))).toHaveLength(4);
  });

  it("fails discovery on crafted credentials and never interpolates them into hop URLs (REEA-152)", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.endsWith("eureka.com.kw/")) {
        // Crafted homepage: appId carries an origin + query + fragment; the
        // searchKey is well-formed so only the allowlist check can trip here.
        return new Response(
          '<input id="cky" value="evil.example/?a#"><input id="srcapk" value="validkey12">',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.includes("algolia.net")) return jsonResponse({ hits: [] });
      return jsonResponse({});
    };

    const first = await collectLiveResults("samsung", { fetchImpl });
    const second = await collectLiveResults("samsung", { fetchImpl });

    // Discovery failed closed on both calls…
    expect(first.notes.find((n) => n.merchant === "Eureka")?.error).toBeTruthy();
    expect(second.notes.find((n) => n.merchant === "Eureka")?.error).toBeTruthy();
    // …without poisoning the cache: the mismatch skipped writeDiscovery, so
    // every call re-ran the homepage hop (old code cached after one hop).
    expect(calls.filter((u) => u.startsWith("https://www.eureka.com.kw/"))).toHaveLength(2);
    // The crafted value never interpolated into a follow-up fetch URL.
    expect(calls.filter((u) => u.includes("evil.example"))).toHaveLength(0);
  });

  it("survives a transient amazon.eg HTTP 503 with one backed-off retry (REEA-149)", async () => {
    resetDiscoveryCache();
    let amazonCalls = 0;
    const cardsHtml =
      'data-component-type="s-search-result" <h2 aria-label="LG gram 16 Notebook"></h2>' +
      '<span class="a-offscreen">EGP 45,900</span><a href="/dp/B1LGGRM">z</a>';
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("amazon.eg")) {
        amazonCalls++;
        if (amazonCalls === 1) return new Response("busy", { status: 503 });
        return new Response(cardsHtml, { headers: { "content-type": "text/html" } });
      }
      return jsonResponse({});
    };

    const { products, notes } = await collectLiveResults("lg gram", { fetchImpl });

    // The 503 no longer throws past the retry loop: exactly one backed-off
    // retry, and Amazon.eg renders beside the other retailers' pockets.
    expect(amazonCalls).toBe(2);
    expect(notes.find((n) => n.merchant === "Amazon.eg")?.error).toBeFalsy();
    const offers = products.flatMap((p) => p.offers).filter((o) => o.merchant === "Amazon.eg");
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(offers[0]).toMatchObject({ price: 45900, currency: "EGP" });
  });
});

describe("collectLiveResults depth pass (REEA-149)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Fixture shaped from live answers: the Constructor endpoint answers the
  // bare code "WH-1000XM6" with filler titles that fail relevance, but the
  // brand+code form "Sony WH-1000XM6 ..." returns the real headphone hits.
  function modelCodeFetch(calls: string[]) {
    return async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_reea149x" y', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("cnstrc.com")) {
        const path = decodeURIComponent(url.split("?")[0].replace("https://ac.cnstrc.com/search/", ""));
        if (path.toLowerCase().startsWith("sony")) {
          return jsonResponse({
            response: {
              results: [
                { data: { url: "sony-mark-6", price: 1699, metadata: { name: "Sony Mark 6 Over-Ear Headphones, Active Noise Cancelling, Bluetooth, Wireless, Black" } } },
              ],
            },
          });
        }
        return jsonResponse({ response: { results: [{ data: { url: "ebook", price: 24, metadata: { name: "W W W, eBook" } } }] } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="appr"><input id="srcapk" value="keyr149abc">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones", slug: "xm6", price: 449, currency: "KWD", inStock: true }] }],
        });
      }
      if (url.includes("algolia.net")) {
        return jsonResponse({ hits: [{ itmn: "Sony WH-1000XM6 Headphones", objectID: "7001", clprc: 439, avaqt: 3 }] });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "Sony WH-1000XM6", handle: "xm6", variants: [{ price: "430.00", available: true }] }] });
      }
      if (url.includes("sultan-center.com")) {
        return jsonResponse({ status: "1", products: { product_list: [{ name: "Sony WH-1000XM6", slug: "xm6", price: "425.0000", is_in_stock: "1" }] } });
      }
      return new Response('data-component-type="s-search-result" <h2 aria-label="Sony WH-1000XM6 Headphones"></h2><span class="a-offscreen">EGP 15,900</span><a href="/dp/XM612345">z</a>');
    };
  }

  it("re-queries silent retailers under the enriched brand+code form", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const { products, notes } = await collectLiveResults("WH-1000XM6", { fetchImpl: modelCodeFetch(calls) });

    const cnstrcCalls = calls.filter((u) => u.includes("cnstrc.com"));
    // Raw code first, then exactly one enriched retry — bounded, not per-form.
    expect(cnstrcCalls).toHaveLength(2);
    expect(decodeURIComponent(cnstrcCalls[1])).toContain("Sony WH-1000XM6");

    // Jarir's live offer now renders beside the round-one merchants.
    const merchants = new Set(products.flatMap((p) => p.offers.map((o) => o.merchant)));
    expect(merchants.has("Jarir")).toBe(true);
    expect(merchants.has("Xcite")).toBe(true);
    const jarirNote = notes.find((n) => n.merchant === "Jarir")!;
    expect(jarirNote.hits).toBe(1);
    expect(jarirNote.error).toBeUndefined();
  });

  it("merchants that answered in round one are not re-fetched", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    await collectLiveResults("WH-1000XM6", { fetchImpl: modelCodeFetch(calls) });
    const xciteCalls = calls.filter((u) => u.includes("xcite.com")).length;
    expect(xciteCalls).toBe(1);
  });

  it("answered merchants keep single round-trip chains", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    await collectLiveResults("WH-1000XM6", { fetchImpl: modelCodeFetch(calls) });
    const eurekaHops = calls.filter((u) => u.endsWith("eureka.com.kw/")).length;
    expect(eurekaHops).toBe(1);
  });

  it("skips the enriched round when round one collects nothing at all", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_empty01" y', { headers: { "content-type": "text/html" } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="appe"><input id="srcapk" value="keye149abc">', { headers: { "content-type": "text/html" } });
      }
      return jsonResponse({});
    };
    const { products } = await collectLiveResults("quiet-widget", { fetchImpl });
    expect(products).toHaveLength(0);
    expect(calls.filter((u) => u.includes("cnstrc.com"))).toHaveLength(1);
  });
});

describe("collectLiveResults page width (REEA-156)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Thin tail-model fixture: every retailer answers "lg gram" with one
  // relevant hit, so no enriched retry runs and each endpoint is seen once.
  function widthFetch(seen: { url: string; body?: BodyInit | null }[]) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, ...(init?.body != null ? { body: init.body } : {}) });
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_width001" y', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("cnstrc.com")) {
        return jsonResponse({ response: { results: [{ data: { url: "lg-gram-16", price: 429, metadata: { name: "LG gram 16 Notebook" } } }] } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="appw"><input id="srcapk" value="keywidth1">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({ results: [{ hits: [{ name: "LG gram 16 Notebook", slug: "lgg16", price: 399, currency: "KWD", inStock: true }] }] });
      }
      if (url.includes("algolia.net")) {
        return jsonResponse({ hits: [{ itmn: "LG gram 16 Notebook", objectID: "8001", clprc: 389, avaqt: 2 }] });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "LG gram 16 Notebook", handle: "lgg16", variants: [{ price: "395.00", available: true }] }] });
      }
      if (url.includes("sultan-center.com")) {
        return jsonResponse({ status: "1", products: { product_list: [{ name: "LG gram 16 Notebook", slug: "lgg16", price: "379.0000", is_in_stock: "1" }] } });
      }
      return new Response('data-component-type="s-search-result" <h2 aria-label="LG gram 16 Notebook"></h2><span class="a-offscreen">EGP 12,900</span><a href="/dp/LGG16161">z</a>');
    };
  }

  it("carries the widened page on every retailer's page-size parameter", async () => {
    resetDiscoveryCache();
    const seen: { url: string; body?: BodyInit | null }[] = [];
    await collectLiveResults("lg gram", { fetchImpl: widthFetch(seen) });
    const n = LIVE_SEARCH_HITS_PER_PAGE;
    const bodyOf = (match: (url: string) => boolean) => {
      const hit = seen.find((s) => match(s.url));
      return typeof hit?.body === "string" ? JSON.parse(hit.body) : undefined;
    };

    const xciteBody = bodyOf((u) => u.includes("xcite.com"));
    expect(xciteBody?.requests?.[0]?.params?.hitsPerPage).toBe(n);
    const eurekaBody = bodyOf((u) => u.includes("algolia.net"));
    expect(String(eurekaBody?.params)).toContain(`hitsPerPage=${n}`);
    const sultanBody = bodyOf((u) => u.includes("sultan-center.com"));
    expect(sultanBody?.pagesize).toBe(n);

    const blink = seen.find((s) => s.url.includes("blink.com.kw"));
    expect(blink?.url).toContain(`limit=${n}`);
    const jarir = seen.find((s) => s.url.includes("cnstrc.com"));
    expect(decodeURIComponent(jarir?.url ?? "")).toContain(`num_results_per_page=${n}`);
  });

  it("keeps the widened page above the thin 12-hit window it replaces", () => {
    // The old 12-hit page measured binding on tail queries (xcite answered a
    // full 12-item page for "airpods pro 2" / "lg gram"); the replacement
    // must stay strictly wider so the depth-of-list fix does not regress.
    expect(LIVE_SEARCH_HITS_PER_PAGE).toBeGreaterThanOrEqual(24);
  });

  it("holds the fan-out window no stricter than the per-retailer budget", () => {
    // REEA-156: deployed loads showed retailers answering inside the page's
    // own ~4 s floor being discarded by a stricter attempt window. The
    // attempt ceiling must stay at or above the product-page collection
    // runner's per-retailer budget it is meant to mirror.
    expect(LIVE_SEARCH_TIMEOUT_MS).toBeGreaterThanOrEqual(PER_RETAILER_TIMEOUT_MS);
    // Two bounded rounds (parallel fan-out + enriched retry), each at most
    // the doubled two-step chain — the documented ceiling covers them both.
    expect(LIVE_SEARCH_BUDGET_MS).toBeGreaterThanOrEqual(LIVE_SEARCH_TIMEOUT_MS * 2 * 2);
  });

  describe("country filter (REEA-170)", () => {
    function jsonResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }

    it("parsers tag hits with their adapter's storefront country", () => {
      const xcite = xciteHits(
        { results: [{ hits: [{ name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true }] }] },
        "airpods",
      );
      expect(xcite[0].country).toBe("KW");
      const jarir = jarirHits(
        { response: { results: [{ data: { url: "p/ap2", price: 909, metadata: { name: "Apple AirPods Pro 2" } } }] } },
        "airpods",
      );
      expect(jarir[0].country).toBe("SA");
      const amz = amazonEgHits(
        'x data-component-type="s-search-result" <h2 aria-label="Apple AirPods Pro 2"></h2><span class="a-offscreen">EGP 11,900</span><a href="/dp/AP1234567">y</a>',
        "airpods",
      );
      expect(amz[0].country).toBe("EG");
    });

    it("Kuwait selection serves only Kuwait-country hits and skips foreign adapters", async () => {
      resetDiscoveryCache();
      const seen: string[] = [];
      const fetchImpl = async (url: string): Promise<Response> => {
        seen.push(url);
        if (url.includes("xcite.com")) {
          return jsonResponse({ results: [{ hits: [{ name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true }] }] });
        }
        if (url.includes("sultan-center.com")) {
          return jsonResponse({ status: "1", products: { product_list: [{ name: "Apple AirPods Pro 2", slug: "app2", price: "69.9000", is_in_stock: "1" }] } });
        }
        return new Response("nope");
      };
      const { products } = await collectLiveResults("airpods", { fetchImpl, country: "KW" });
      expect(products).toHaveLength(1);
      const merchants = products[0].offers.map((o) => o.merchant);
      expect(merchants).toContain("Xcite");
      expect(merchants).toContain("Sultan Center");
      expect(merchants).not.toContain("Jarir");
      expect(merchants).not.toContain("Amazon.eg");
      // Rate-limit citizenship: foreign adapters are not even contacted when
      // their hits could only be filtered out.
      expect(seen.some((u) => u.includes("cnstrc.com"))).toBe(false);
      expect(seen.some((u) => u.includes("amazon.eg"))).toBe(false);
    });

    it("without a selection every adapter keeps serving (default unchanged)", async () => {
      resetDiscoveryCache();
      const fetchImpl = async (url: string): Promise<Response> => {
        if (url.endsWith("jarir.com/")) {
          return new Response('x searchProviderKeys "key_test123456" y', { headers: { "content-type": "text/html" } });
        }
        if (url.includes("cnstrc.com")) {
          return jsonResponse({ response: { results: [{ data: { url: "p/ap2", price: 909, metadata: { name: "Apple AirPods Pro 2" } } }] } });
        }
        if (url.includes("xcite.com")) {
          return jsonResponse({ results: [{ hits: [{ name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true }] }] });
        }
        if (url.includes("amazon.eg")) {
          return new Response('data-component-type="s-search-result" <h2 aria-label="Apple AirPods Pro 2"></h2><span class="a-offscreen">EGP 11,900</span><a href="/dp/AP1234567">y</a>');
        }
        return new Response("nope");
      };
      const { products } = await collectLiveResults("airpods", { fetchImpl });
      expect(products).toHaveLength(1);
      const merchants = products[0].offers.map((o) => o.merchant);
      // All "All": foreign listings stay on the page, exactly as today.
      expect(merchants).toContain("Xcite");
      expect(merchants).toContain("Jarir");
      expect(merchants).toContain("Amazon.eg");
    });
  });
});

describe("collectLiveResultsStaged (REEA-178)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Fast KW electronics retailers answer immediately; the two-step Eureka
  // chain and the slow Sultan storefront answer after a short delay — so the
  // first flush must already serve while those hops are still in flight.
  function mixedSpeedFetch(): FetchImplLike {
    return async (url: string): Promise<Response> => {
      if (url.endsWith("eureka.com.kw/")) {
        return new Promise((res) =>
          setTimeout(
            () => res(new Response('<input id="cky" value="APPS1"><input id="srcapk" value="keyStage01">', { headers: { "content-type": "text/html" } })),
            30,
          ),
        );
      }
      if (url.includes("algolia.net")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9101", clprc: 379, avaqt: 3 }] }),
              ),
            30,
          ),
        );
      }
      if (url.includes("sultan-center.com")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                jsonResponse({
                  status: "1",
                  products: { product_list: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: "385.0000", is_in_stock: "1" }] },
                }),
              ),
            30,
          ),
        );
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }],
        });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "Samsung Galaxy S26 Ultra", handle: "s26u", variants: [{ price: "390.00", available: true }] }] });
      }
      return jsonResponse({});
    };
  }

  type FetchImplLike = (url: string, init?: RequestInit) => Promise<Response>;

  it("flushes the fast retailers' offers while slower hops are still in flight", async () => {
    resetDiscoveryCache();
    const staged = collectLiveResultsStaged("samsung", { fetchImpl: mixedSpeedFetch(), country: "KW" });

    const first = await staged.stages[0];
    expect(first.products).toHaveLength(1);
    // AC-1: a real price renders from the answered adapters alone.
    expect(first.products[0].offers.some((o) => o.merchant === "Xcite" || o.merchant === "Blink")).toBe(true);
    // Slow hops had no say in the first flush.
    expect(first.notes.length).toBeLessThanOrEqual(2);
    // AC-3: every snapshot carries its own real completion stamp.
    expect(Date.now() - Date.parse(first.products[0].scrapedAt!)).toBeLessThan(5_000);

    const finalSnap = await staged.final;
    const merchants = new Set(finalSnap.products.flatMap((p) => p.offers.map((o) => o.merchant)));
    // AC-2 on the data side: the early card survives into the final flush as
    // the FIRST card, carrying the merged union (cheapest first).
    expect(finalSnap.products[0].productId).toBe(first.products[0].productId);
    expect(finalSnap.products[0].offers.map((o) => o.price)).toEqual([379, 385, 390, 399]);
    expect(merchants.has("Eureka")).toBe(true);
    expect(merchants.has("Sultan Center")).toBe(true);
    expect(finalSnap.notes).toHaveLength(4);
  });

  it("the final flush equals the blocking path on the same live answers", async () => {
    resetDiscoveryCache();
    const staged = await collectLiveResultsStaged("samsung", { fetchImpl: mixedSpeedFetch(), country: "KW" }).final;
    const blocking = await collectLiveResults("samsung", { fetchImpl: mixedSpeedFetch(), country: "KW" });
    const shape = (s: typeof staged) => s.products.map((p) => [p.productId, p.offers.map((o) => `${o.merchant}:${o.price}`)]);
    expect(shape(staged)).toEqual(shape(blocking));
  });
});

describe("brand chain (REEA-189)", () => {
  it("reads the retailer brand field into hits when the contract carries one", () => {
    const hits = xciteHits(
      { results: [{ hits: [{ name: "Sony WH-1000XM6 Wireless Headphones", slug: "xm6", price: 120, currency: "KWD", inStock: true, brand: "SONY" }] }] },
      "wh-1000xm6",
    );
    expect(hits[0].brand).toBe("SONY");
  });

  it("Shopify vendor rides into the hit brand", () => {
    const hits = blinkHits(
      { products: [{ title: "Bose QuietComfort Ultra Earbuds", handle: "qcues", vendor: "Bose", variants: [{ price: "89.00", available: true }] }] },
      "bose quietcomfort",
    );
    expect(hits[0].brand).toBe("Bose");
  });

  it("a retailer without a brand field inherits the merged group's first brand", () => {
    const products = groupHits("bose qc", [
      { title: "Bose QuietComfort Ultra Earbuds", merchant: "Xcite", country: "KW", price: 90, currency: "KWD", url: "https://www.xcite.com/qc/p", inStock: true, brand: "BOSE" },
      { title: "Bose QuietComfort Ultra Earbuds Black", merchant: "Eureka", country: "KW", price: 85, currency: "KWD", url: "https://www.eureka.com.kw/qc", inStock: true },
    ]);
    const card = products.find((p) => p.offers.some((o) => o.merchant === "Eureka"));
    expect(card?.brand).toBe("Bose");
  });

  it("artifact stop-values and missing fields fall back to the curated title match, never a first word", () => {
    const products = groupHits("compatible airfryer", [
      { title: "Airfryer XL Basket Non-Stick", merchant: "Xcite", country: "KW", price: 25, currency: "KWD", url: "https://www.xcite.com/af/p", inStock: true, brand: "Case" },
      { title: "Compatible with Philips Airfryer XL", merchant: "Eureka", country: "KW", price: 22, currency: "KWD", url: "https://www.eureka.com.kw/af", inStock: true },
    ]);
    // "Case"/missing brand → curated whole-word match on the title, not the first word.
    expect(products.find((p) => p.title.startsWith("Compatible"))?.brand).toBe("Philips");
    // No curated brand anywhere and a stop-value field → honest "no brand line".
    const plain = groupHits("basket", [
      { title: "Basket Non-Stick 5L", merchant: "Xcite", country: "KW", price: 9, currency: "KWD", url: "https://www.xcite.com/b/p", inStock: true, brand: "Privacy" },
    ]);
    expect(plain[0].brand).toBe("");
  });
});
