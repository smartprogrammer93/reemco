/**
 * REEA-1200 (Bet 7A-1) — the deterministic relevance/scope gate. These are
 * the AC pins plus the negative controls the DoD names: S25 ≠ S26,
 * Tune 500 ≠ Tune 510BT, Panadol ≠ unrelated medicine. Every title below is
 * a live row measured in bet-7 Appendix A (served head `bd3806a3`), so the
 * test pins the defect the ticket was filed for, not a synthetic guess.
 */
import { describe, expect, it } from "vitest";
import {
  carriesQueryIdentity,
  classifyProductScope,
  isPackVariant,
  isPrimaryShelfScope,
  modelIdentityPasses,
  queryProductClass,
  stampScopeFields,
  titleProductClasses,
} from "@/lib/scope-gate";

const verdict = (query: string, title: string) => classifyProductScope(query, title);

describe("AC 7a-1 — every card carries a valid matchReason/productScope pair", () => {
  it("stamps both fields on every card and keeps the enum closed", () => {
    const titles = [
      "Panadol Pain Relief Tablets 24Tablets",
      "Dove Cucumber & Green Tea Soap 125g",
      "Cucumber 1kg",
      "Delsey Laptop Bag",
      "Samsung Galaxy S25 Ultra Silicone Case, EF-PS938CLEGWW - Light Blue",
      "JBL Tune 500 On-Ear Headphones, Wired, 3.5 mm Connector",
    ];
    const stamped = stampScopeFields("laptop", titles.map((title) => ({ title })));
    for (const card of stamped) {
      expect(["query_token", "brand_family", "storefront_ranked", "related"]).toContain(card.matchReason);
      expect(["primary", "accessory", "consumable", "variant"]).toContain(card.productScope);
    }
    expect(stamped).toHaveLength(titles.length);
  });

  it("never admits a related or accessory/consumable card to the primary shelf", () => {
    expect(isPrimaryShelfScope({ matchReason: "query_token", productScope: "primary" })).toBe(true);
    expect(isPrimaryShelfScope({ matchReason: "storefront_ranked", productScope: "variant" })).toBe(true);
    expect(isPrimaryShelfScope({ matchReason: "related", productScope: "primary" })).toBe(false);
    expect(isPrimaryShelfScope({ matchReason: "query_token", productScope: "accessory" })).toBe(false);
    expect(isPrimaryShelfScope({ matchReason: "query_token", productScope: "consumable" })).toBe(false);
  });
});

describe("AC 7a-2 — panadol: only the paracetamol family is in scope", () => {
  const query = "panadol";
  const inScope = [
    "Panadol Pain Relief Tablets 24Tablets",
    "Panadol Advance Tablets 1Pack",
    "Panadol Extra Pain Relief Tablets 24tablets",
    "Panadol ActiFast Pain Relief Tablets 20Tablets",
  ];
  const filler = [
    "Cricut Joy 11.4 x 15.9cm Card Mat, 1-pack, 2007968 - Blue",
    "Fairy 1 Step Clean Plus Automatic Diswhasher Tablets",
    "Advanced Medication Administration Skills",
    "Powerology Advanced Precision Smart Scale - Black",
    "NeoCell Grassfed Collagen + Vit C & Biotin Tablets, Pack of 180's",
    "Lorgar Advance Rapax 701 HD Webcam, LRG-SC701BL - Blue",
  ];

  it("keeps the four real Panadol rows primary", () => {
    for (const title of inScope) {
      const v = verdict(query, title);
      expect(v.productScope).toBe("primary");
      expect(v.matchReason).toBe("query_token");
      expect(isPrimaryShelfScope(v)).toBe(true);
    }
  });

  it("suppresses every filler row from the primary shelf", () => {
    for (const title of filler) {
      const v = verdict(query, title);
      expect(isPrimaryShelfScope(v)).toBe(false);
      expect(["accessory", "consumable"]).toContain(v.productScope);
      expect(v.matchReason).toBe("related");
    }
  });

  it("does not let an unrelated medicine become primary", () => {
    expect(isPrimaryShelfScope(verdict(query, "NeoCell Grassfed Collagen + Vit C & Biotin Tablets"))).toBe(false);
    expect(isPrimaryShelfScope(verdict(query, "Panadrex Paracetamol Tablets"))).toBe(false);
  });
});

describe("AC 7a-3 — cucumber: only fresh cucumber, pack-size variants allowed", () => {
  const query = "cucumber";
  it("keeps cucumber rows primary (variants included)", () => {
    for (const title of ["Cucumber 1kg", "Cucumber (Tray) 900g", "Small Cucumber (Pack)", "Al Qasim Produce Cucumber (Tray) 1kg"]) {
      const v = verdict(query, title);
      expect(isPrimaryShelfScope(v)).toBe(true);
      expect(v.productScope === "primary" || v.productScope === "variant").toBe(true);
    }
  });

  it("drops the Dove soap/deodorant, laban drink, pickle and slime toy", () => {
    const offScope: [string, string][] = [
      ["Dove Cucumber & Green Tea Soap 125g", "consumable"],
      ["Dove Go Fresh Cucumber & Green Tea Anti-Perspirant Deodorant Roll On 50ml", "consumable"],
      ["Dove Antiperspirant Spray Cucumber & Green Tea Scent 150ml", "consumable"],
      ["Nadec Ayran Cucumber & Mint Laban Drink 225ml", "consumable"],
      ["Baidar Pickled Cucumber 600g", "consumable"],
      ["O! Slime Cucumber Green - Clear Slime Toy, Green, 6 Years and Above", "accessory"],
    ];
    for (const [title, scope] of offScope) {
      const v = verdict(query, title);
      expect(v.productScope).toBe(scope);
      expect(isPrimaryShelfScope(v)).toBe(false);
    }
  });

  it("is locale-independent — the Arabic aisle words answer the same classes", () => {
    expect(verdict("خيار", "خيار 1 كجم").productScope).toBe("variant");
    expect(isPrimaryShelfScope(verdict("خيار", "دوف صابون خيار والشاي الأخضر 125 جم"))).toBe(false);
    expect(verdict("خيار", "دوف صابون خيار والشاي الأخضر 125 جم").productScope).toBe("consumable");
    expect(verdict("خيار", "مخلل خيار 600 جم").productScope).toBe("consumable");
    expect(verdict("خيار", "لعبة سلايم خيار")).toBeTruthy();
    expect(isPrimaryShelfScope(verdict("خيار", "لعبة سلايم خيار"))).toBe(false);
  });
});

describe("AC 7a-4 — s25 ultra: phones primary, accessories only in the band", () => {
  const query = "samsung galaxy s25 ultra";
  it("keeps the S25-family phone primary", () => {
    const v = verdict(query, "Samsung S25 Ultra 6.9-inch,");
    expect(v.productScope).toBe("primary");
    expect(isPrimaryShelfScope(v)).toBe(true);
  });

  it("moves every case/protector/lens row to the accessory band", () => {
    for (const title of [
      "Samsung Galaxy S25 Ultra  Anti-Reflecting Screen Protector, (2 pack), EF-US938CTEGWW – Transparent",
      "Samsung Galaxy S25 Ultra Silicone Case, EF-PS938CLEGWW - Light Blue",
      "Belkin Screen Protector for Samsung Galaxy S25 Ultra, OVB050HQ - Clear",
      "Panzer Hoops Lens Protector Samsung Galaxy S25 Ultra – Transparent",
      "PanzerGlass Panzer Ultra-Wide Fit Screen Protector for Samsung Galaxy S25 Ultra – Privacy",
      "PanzerGlass Panzer Kickstand Case for Samsung Galaxy S25 Ultra, CRRFBKQG38488 - Clear",
      "ESR Lens Protector Samsung Galaxy S25 Ultra – Clear",
      "UAG Plasma Xte Case with Magnet for Samsung Galaxy S25 Ultra, 214467114097 - Black & Orange",
    ]) {
      const v = verdict(query, title);
      expect(v.productScope).toBe("accessory");
      expect(isPrimaryShelfScope(v)).toBe(false);
    }
  });
});

describe("AC 7a-5 — laptop: laptops primary, bags/trolleys/backpacks accessory", () => {
  const query = "laptop";
  it("keeps laptops in scope, including neutral class rows", () => {
    for (const title of [
      "HP Laptop, AMD Ryzen 5, 8GB RAM, 512GB SSD, AMD Radeon, 15.6-Inch, Windows 11 Home, 15-FC0070NE - Silver",
      "Asus Vivobook Laptop, 14\", AMD Ryzen 5, 8 GB RAM, 512 GB PCIe NVMe M.2 SSD, Windows 11 Home",
      "Dell Laptop Pro 15 Essential PV15250 - 15.6 Inch FHD Non-Touch -  i7 - 8GB - 512GB (NVMe M.2 SSD) - Eng/Arb Keys",
      // Neutral row: no "laptop" word, but the retailer ranked it under the
      // class — it stays primary (AC 7a-5 requires the pool's laptops render).
      "Acer Aspire 3 A315-24P-R7VH 15.6-inch Ryzen 3 7320U 8GB 128GB SSD",
    ]) {
      expect(isPrimaryShelfScope(verdict(query, title))).toBe(true);
    }
  });

  it("keeps bags, trolleys and backpacks out of primary slots", () => {
    for (const title of ["Delsey Laptop Bag", "Delsey Trolley 55cm", "Laptop Backpack 15.6 inch", "HP Laptop Sleeve 14\""]) {
      const v = verdict(query, title);
      expect(v.productScope).toBe("accessory");
      expect(isPrimaryShelfScope(v)).toBe(false);
    }
  });
});

describe("AC 7a-7 — a nonsense query answers with nothing in scope", () => {
  it("has no primary-scope card when nothing carries the query", () => {
    expect(queryProductClass("zzzzqqq")).toBeNull();
    expect(carriesQueryIdentity("zzzzqqq", "JBL Tune 500 On-Ear Headphones")).toBe(false);
    expect(isPrimaryShelfScope(verdict("zzzzqqq", "JBL Tune 500 On-Ear Headphones"))).toBe(false);
  });
});

describe("AC 7a-8 — regression guard: headphones/iphone in-scope cards stay primary", () => {
  it("keeps every headphone row primary", () => {
    for (const title of [
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
    ]) {
      expect(isPrimaryShelfScope(verdict("headphones", title))).toBe(true);
    }
  });

  it("keeps iPhone 17 Pro phone cards primary and accessories in the band", () => {
    for (const title of [
      "Apple iPhone 17 Pro 256Gb Silver",
      "Apple iPhone 17 Pro Max - eSIM",
      "Apple iPhone 17 Pro 512GB - Cosmic Orange",
      "Apple iPhone 17 Pro Max 512Gb Silver",
      "Apple iPhone 17 Pro 6.3 Inch 1TB 5G Cosmic Orange",
      "Apple iPhone 17 Pro Max 1TB Cosmic Silver",
      "Apple iPhone 17 Pro Max 6.9\" 2TB - Cosmic Orange",
    ]) {
      expect(isPrimaryShelfScope(verdict("iphone 17 pro", title))).toBe(true);
    }
    // The "+ Wireless Charger" bundle and the clear case are accessory-marked
    // rows: the confidence ladder already demoted them to the related band
    // before this change, so the gate must keep them out of primary — never
    // drop a card that was primary.
    for (const title of [
      "Apple iPhone 17 Pro 5G 256 GB, Silver + Wireless Charger",
      "Apple iPhone 17 Pro 5G 512 GB, Cosmic Orange + Wireless Charger",
      "Apple iPhone 17 Pro Clear Case with MagSafe MGFT4ZM/A",
    ]) {
      const v = verdict("iphone 17 pro", title);
      expect(v.productScope).toBe("accessory");
      expect(isPrimaryShelfScope(v)).toBe(false);
    }
  });
});

describe("negative controls — a different model is never the queried product", () => {
  it("S25 ≠ S26", () => {
    expect(modelIdentityPasses("samsung galaxy s25 ultra", "Samsung Galaxy S25 Ultra 512GB")).toBe(true);
    expect(modelIdentityPasses("samsung galaxy s25 ultra", "Samsung Galaxy S26 Ultra 512GB")).toBe(false);
    const s26 = verdict("samsung galaxy s25 ultra", "Samsung Galaxy S26 Ultra 512GB");
    expect(s26.matchReason).toBe("related");
    expect(isPrimaryShelfScope(s26)).toBe(false);
  });

  it("Tune 500 ≠ Tune 510BT", () => {
    // "500" is a bare numeric model token (digit-led), so the identity guard
    // is the token-coverage rule: the 510BT title never carries "500".
    expect(isPrimaryShelfScope(verdict("jbl tune 500", "JBL Tune 500 On-Ear Headphones"))).toBe(true);
    const v = verdict("jbl tune 500", "JBL Tune 510BT On-Ear Headphones");
    expect(v.matchReason).toBe("related");
    expect(isPrimaryShelfScope(v)).toBe(false);
  });

  it("keeps the class tables honest — a laptop bag names two classes", () => {
    expect(titleProductClasses("Delsey Laptop Bag")).toEqual(new Set(["laptop", "bags"]));
    expect(queryProductClass("laptop")).toBe("laptop");
    expect(queryProductClass("cucumber")).toBe("produce");
    expect(queryProductClass("panadol")).toBeNull();
  });

  it("classifies pack-size variants without turning them off-scope", () => {
    expect(isPackVariant("Cucumber 1kg")).toBe(true);
    expect(isPackVariant("Small Cucumber (Pack)")).toBe(true);
    expect(isPackVariant("Cucumber (Tray) 900g")).toBe(true);
    expect(isPackVariant("Samsung S25 Ultra 6.9-inch")).toBe(false);
  });
});

describe("AC 7a-6 — in-scope cards are never `related` (no related card fills a slot)", () => {
  it("every primary/variant verdict carries a real match reason", () => {
    const cases: [string, string][] = [
      ["panadol", "Panadol Pain Relief Tablets 24Tablets"],
      ["cucumber", "Cucumber 1kg"],
      ["laptop", "Acer Aspire 3 A315-24P-R7VH 15.6-inch Ryzen 3 7320U 8GB 128GB SSD"],
      ["headphones", "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black"],
      ["samsung galaxy s25 ultra", "Samsung S25 Ultra 6.9-inch,"],
      ["iphone 17 pro", "Apple iPhone 17 Pro 256Gb Silver"],
    ];
    for (const [query, title] of cases) {
      const v = verdict(query, title);
      expect(isPrimaryShelfScope(v)).toBe(true);
      expect(v.matchReason).not.toBe("related");
    }
  });
});
