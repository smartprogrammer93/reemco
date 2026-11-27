/**
 * REEA-1200 (Bet 7A-1) — the shelf-level pins for the relevance/scope gate.
 *
 * These exercise the ONE chain the results page renders
 * (`shelfSectionsFromProducts`), with the exact live rows bet-7 Appendix A
 * measured on the served head: the shelf must render exactly the in-scope
 * count (no padding), accessories/consumables must move to their own band
 * lists, and a `related` row must never fill a primary slot. AC 7a-6's
 * "rendered primary-card count == payload primary-scope count" is pinned here
 * as the sections' primary length against the payload's in-scope cards.
 */
import { describe, expect, it } from "vitest";
import { shelfSectionsFromProducts, resultsShelfCards } from "@/lib/results-shelf";
import { classifyProductScope, isPrimaryShelfScope, stampScopeFields } from "@/lib/scope-gate";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

function offer(overrides: Partial<PriceOffer> = {}): PriceOffer {
  return {
    merchant: "Danube Home",
    price: 100,
    currency: "SAR",
    url: "https://danube.example/listing",
    inStock: true,
    ...overrides,
  };
}

let seq = 0;
function product(title: string, overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  seq += 1;
  return {
    productId: `p-${seq}`,
    title,
    brand: "",
    offers: [offer({ url: `https://danube.example/${seq}` })],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

/** Stamp the payload fields the gate writes on every served card (AC 7a-1). */
function stamp(products: NormalizedProduct[], query: string): NormalizedProduct[] {
  return stampScopeFields(query, products);
}

/** The payload primary-scope count the count line must equal (AC 7a-6). */
function payloadPrimaryScopeCount(products: NormalizedProduct[], query: string): number {
  return products.filter((p) => isPrimaryShelfScope(classifyProductScope(query, p.title))).length;
}

describe("AC 7a-6 — the primary shelf renders exactly the in-scope count", () => {
  it("panadol: 4 in-scope rows, 6 filler never fill a slot", () => {
    const query = "panadol";
    const products = [
      product("Panadol Pain Relief Tablets 24Tablets"),
      product("Panadol Advance Tablets 1Pack"),
      product("Panadol Extra Pain Relief Tablets 24tablets"),
      product("Panadol ActiFast Pain Relief Tablets 20Tablets"),
      product("Cricut Joy 11.4 x 15.9cm Card Mat, 1-pack, 2007968 - Blue"),
      product("Fairy 1 Step Clean Plus Automatic Diswhasher Tablets"),
      product("Advanced Medication Administration Skills"),
      product("Powerology Advanced Precision Smart Scale - Black"),
      product("NeoCell Grassfed Collagen + Vit C & Biotin Tablets, Pack of 180's"),
      product("Lorgar Advance Rapax 701 HD Webcam, LRG-SC701BL - Blue"),
    ];
    const sections = shelfSectionsFromProducts(stamp(products, query), query, null, false);
    expect(sections.primary).toHaveLength(4);
    expect(sections.primary).toHaveLength(payloadPrimaryScopeCount(products, query));
    expect(sections.primary.every((p) => /panadol/i.test(p.title))).toBe(true);
    expect(sections.related.every((p) => !/panadol/i.test(p.title))).toBe(true);
    // The filler is off the primary shelf; the payload buckets it into a
    // labelled band below the shelf — never a primary slot. REEA-1261 routes
    // every `related`-matched off-scope card to the related band ("Related
    // items — not an exact match"), so a scale/webcam under `panadol` is no
    // longer labelled an accessory of a product it does not complement.
    expect(sections.accessory.length + sections.related.length).toBeGreaterThan(0);
    expect(sections.related.length).toBeGreaterThan(0);
    expect([...sections.accessory, ...sections.related].some((p) => /panadol/i.test(p.title))).toBe(false);
  });

  it("cucumber: 4 cucumber rows primary, 6 off-scope rows out of the slots", () => {
    const query = "cucumber";
    const products = [
      product("Dove Cucumber & Green Tea Soap 125g"),
      product("Cucumber 1kg"),
      product("Cucumber (Tray) 900g"),
      product("O! Slime Cucumber Green - Clear Slime Toy, Green, 6 Years and Above"),
      product("Dove Go Fresh Cucumber & Green Tea Anti-Perspirant Deodorant Roll On 50ml"),
      product("Dove Antiperspirant Spray Cucumber & Green Tea Scent 150ml"),
      product("Nadec Ayran Cucumber & Mint Laban Drink 225ml"),
      product("Small Cucumber (Pack)"),
      product("Baidar Pickled Cucumber 600g"),
      product("Al Qasim Produce Cucumber (Tray) 1kg"),
    ];
    const sections = shelfSectionsFromProducts(stamp(products, query), query, null, false);
    expect(sections.primary).toHaveLength(4);
    expect(sections.primary).toHaveLength(payloadPrimaryScopeCount(products, query));
    for (const p of sections.primary) expect(/cucumber/i.test(p.title)).toBe(true);
    expect(sections.primary.some((p) => /soap|deodorant|antiperspirant|laban|drink|pickle|slime/i.test(p.title))).toBe(false);
    // The four pack-size variants are classified variants, still in scope.
    expect(sections.primary.some((p) => /1kg|tray|pack/i.test(p.title))).toBe(true);
    expect(sections.accessory.some((p) => /slime/i.test(p.title))).toBe(true);
    expect(sections.related.some((p) => /soap/i.test(p.title))).toBe(true);
  });

  it("s25 ultra: the phone is the only primary card; accessories are band-only", () => {
    const query = "samsung galaxy s25 ultra";
    const products = [
      product("Samsung Galaxy S25 Ultra  Anti-Reflecting Screen Protector, (2 pack), EF-US938CTEGWW – Transparent"),
      product("Samsung Galaxy S25 Ultra Silicone Case, EF-PS938CLEGWW - Light Blue"),
      product("Belkin Screen Protector for Samsung Galaxy S25 Ultra, OVB050HQ - Clear"),
      product("Panzer Hoops Lens Protector Samsung Galaxy S25 Ultra – Transparent"),
      product("Samsung S25 Ultra 6.9-inch,"),
      product("UAG Plasma Xte Case with Magnet for Samsung Galaxy S25 Ultra, 214467114097 - Black & Orange"),
    ];
    const sections = shelfSectionsFromProducts(stamp(products, query), query, null, false);
    expect(sections.primary.map((p) => p.title)).toEqual(["Samsung S25 Ultra 6.9-inch,"]);
    expect(sections.primary).toHaveLength(payloadPrimaryScopeCount(products, query));
    expect(sections.accessory.length).toBeGreaterThanOrEqual(5);
    expect(sections.accessory.every((p) => /case|protector/i.test(p.title))).toBe(true);
  });

  it("laptop: 0 bags/trolleys in primary, laptops render", () => {
    const query = "laptop";
    const products = [
      product("Delsey Laptop Bag"),
      product("Delsey Trolley 55cm"),
      product("HP Laptop, AMD Ryzen 5, 8GB RAM, 512GB SSD, 15.6-Inch"),
      product("Asus Vivobook Laptop, 14\", AMD Ryzen 5, 8 GB RAM"),
      product("Dell Laptop Pro 15 Essential PV15250 - 15.6 Inch FHD"),
      product("Acer Aspire 3 A315-24P-R7VH 15.6-inch Ryzen 3 7320U 8GB 128GB SSD"),
    ];
    const sections = shelfSectionsFromProducts(stamp(products, query), query, null, false);
    expect(sections.primary).toHaveLength(4);
    expect(sections.primary).toHaveLength(payloadPrimaryScopeCount(products, query));
    expect(sections.primary.some((p) => /bag|trolley/i.test(p.title))).toBe(false);
    expect(sections.accessory.some((p) => /bag/i.test(p.title))).toBe(true);
    // A trolley title with no shared token ("Delsey Trolley 55cm") scores 0
    // on the affinity ladder, so it renders nowhere — never in a primary slot.
    expect(sections.primary.some((p) => /trolley/i.test(p.title))).toBe(false);
  });

  it("does not pad: a one-row in-scope answer renders one card", () => {
    const products = [product("Samsung S25 Ultra 6.9-inch,")];
    for (let i = 0; i < 9; i += 1) products.push(product(`Unrelated Widget ${i}`));
    const sections = shelfSectionsFromProducts(stamp(products, "samsung galaxy s25 ultra"), "samsung galaxy s25 ultra", null, false);
    expect(sections.primary).toHaveLength(1);
    expect(resultsShelfCards({ products: stamp(products, "samsung galaxy s25 ultra") }, "samsung galaxy s25 ultra", 1, null, false)).toHaveLength(1);
  });
});

describe("AC 7a-7 — the zzzzqqq control renders no primary cards", () => {
  it("an empty snapshot stays empty and a nonsense query admits nothing", () => {
    expect(shelfSectionsFromProducts([], "zzzzqqq", null, false).primary).toHaveLength(0);
    const products = [product("JBL Tune 500 On-Ear Headphones")];
    const sections = shelfSectionsFromProducts(stamp(products, "zzzzqqq"), "zzzzqqq", null, false);
    expect(sections.primary).toHaveLength(0);
  });
});

describe("AC 7a-8 — regression guard: the Bet 6 panel keeps its primary cards", () => {
  it("headphones: all 10 rows stay primary", () => {
    const titles = [
      "Belkin Rockstar Headphones with USB-C Connector - White",
      "JBL Tune 500 On-Ear Headphones, Wired, 3.5 mm Connector, In-line Microphone, Black",
      "JBL Tune 110BT Wired Headphones, JBLT110BLKE - Black",
      "UGREEN Max 5C Over-Ear Headphones, Active Noise Cancelling, Bluetooth, USB-C, Built-in Microphone, White",
      "BuddyPhones Explore Plus Foldable Headphones with Mic - Yellow",
      "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black",
      "Riwbox Kids Bluetooth Rabbit Headphones - Blue/Green",
      "Anker soundcore Q30 On-Ear Headphones, Active Noise Cancelling, Bluetooth, Built-in Microphone, Black",
      "Belkin SoundForm Mini Wireless On-Ear Kids Headphones -Black",
      "JBL Tune 730BT On-Ear Headphones, Bluetooth, Built-in Microphone, Black",
    ];
    const products = titles.map((t) => product(t));
    const sections = shelfSectionsFromProducts(stamp(products, "headphones"), "headphones", null, false);
    expect(sections.primary).toHaveLength(10);
  });

  it("iphone 17 pro: the 7 phone cards stay primary (≥6 required)", () => {
    const phones = [
      "Apple iPhone 17 Pro 256Gb Silver",
      "Apple iPhone 17 Pro Max - eSIM",
      "Apple iPhone 17 Pro 512GB - Cosmic Orange",
      "Apple iPhone 17 Pro Max 512Gb Silver",
      "Apple iPhone 17 Pro 6.3 Inch 1TB 5G Cosmic Orange",
      "Apple iPhone 17 Pro Max 1TB Cosmic Silver",
      "Apple iPhone 17 Pro Max 6.9\" 2TB - Cosmic Orange",
    ];
    const accessories = [
      "Apple iPhone 17 Pro 5G 256 GB, Silver + Wireless Charger",
      "Apple iPhone 17 Pro 5G 512 GB, Cosmic Orange + Wireless Charger",
      "Apple iPhone 17 Pro Clear Case with MagSafe MGFT4ZM/A",
    ];
    const products = [...phones, ...accessories].map((t) => product(t));
    const sections = shelfSectionsFromProducts(stamp(products, "iphone 17 pro"), "iphone 17 pro", null, false);
    expect(sections.primary).toHaveLength(7);
    expect(sections.primary.length).toBeGreaterThanOrEqual(6);
    expect(sections.primary.every((p) => /iphone 17 pro/i.test(p.title))).toBe(true);
    expect(sections.accessory).toHaveLength(3);
  });
});
