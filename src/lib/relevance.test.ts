/**
 * REEA-189 — relevance-tiering + brand-hygiene unit coverage (REEA-180 spec).
 * Fixtures mirror what the four retailer adapters actually emit on the
 * sampled queries: English-style titles for "آيفون 17", Arabic-script titles
 * for "سماعة أبل", artifact-first-word titles from case listings.
 */
import { describe, expect, it } from "vitest";
import {
  CURATED_BRANDS,
  curatedBrandInTitle,
  isAccessoryTitle,
  partitionForQuery,
  resolveBrand,
  titleHasDeviceIntent,
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
