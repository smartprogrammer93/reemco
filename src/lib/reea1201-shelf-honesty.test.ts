/**
 * REEA-1201 (Bet 7A-2) — pure honest-shelf logic: the payload-scope partition,
 * the in-scope count, the thin-shelf decision and the EN/AR plural ladder.
 *
 * The UI must never compute `productScope` itself: these tests pin that the
 * partition reads the payload's field, that accessory/consumable cards never
 * enter the primary shelf, and that the thin-shelf test uses the same
 * comparison-merchant count the card basis prints.
 */
import { describe, expect, it } from "vitest";
import { shelfSectionsFromProducts } from "@/lib/results-shelf";
import { inScopeCountText, isThinShelf, shelfHasCrossRetailerMatch } from "@/lib/shelf-honesty";
import type { NormalizedProduct } from "@/types/product";

function product(
  id: string,
  title: string,
  scope: NormalizedProduct["productScope"],
  offers: NormalizedProduct["offers"],
  matchReason?: NormalizedProduct["matchReason"],
): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "Samsung",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
    productScope: scope,
    matchReason: matchReason ?? (scope === "primary" ? "query_token" : "related"),
  };
}

const kwd = (merchant: string, price: number): NormalizedProduct["offers"][number] => ({
  merchant,
  price,
  currency: "KWD",
  url: `https://${merchant.toLowerCase()}.example/p`,
  inStock: true,
});

describe("REEA-1201 — payload-scope partition", () => {
  it("puts only primary/variant cards on the shelf; accessory and consumable never do", () => {
    const products = [
      product("phone", "Samsung Galaxy S25 Ultra", "primary", [kwd("Xcite", 289.9), kwd("Jarir", 299.9)]),
      product("phone-variant", "Samsung Galaxy S25 Ultra 512GB", "variant", [kwd("Eureka", 319.9)]),
      product("case", "Samsung Galaxy S25 Ultra Silicone Case", "accessory", [kwd("Xcite", 9.9)], "query_token"),
      product("screen", "Samsung Galaxy S25 Ultra Screen Protector", "accessory", [kwd("Jarir", 4.9)], "query_token"),
      product("soap", "Dove Cucumber Soap", "consumable", [kwd("Sultan Center", 1.2)]),
    ];
    const sections = shelfSectionsFromProducts(products, "samsung galaxy s25 ultra", "KW", false);
    expect(sections.primary.map((p) => p.productId)).toEqual(["phone", "phone-variant"]);
    expect(sections.accessory.map((p) => p.productId)).toEqual(["case", "screen"]);
    expect(sections.related.map((p) => p.productId)).toEqual(["soap"]);
  });

  it("counts the primary shelf exactly (the honest in-scope number)", () => {
    const products = [
      product("a", "Panadol Pain Relief Tablets", "primary", [kwd("Xcite", 1.5)]),
      product("b", "Panadol Advance Tablets", "primary", [kwd("Jarir", 1.7)]),
      product("c", "Panadol Extra Tablets", "primary", [kwd("Eureka", 1.9)]),
      product("d", "Cricut Joy Card Mat", "consumable", [kwd("Xcite", 8.9)]),
    ];
    const sections = shelfSectionsFromProducts(products, "panadol", "KW", false);
    expect(sections.primary.length).toBe(3);
    expect(sections.accessory.length).toBe(0);
  });

  it("keeps the pre-gate confidence partition when no card carries a scope", () => {
    const products = [
      product("panadol", "Panadol Pain Relief Tablets 24Tablets", undefined, [kwd("Xcite", 1.5)]),
      product("filler", "Cricut Joy Card Mat", undefined, [kwd("Jarir", 8.9)]),
    ];
    const sections = shelfSectionsFromProducts(products, "panadol", "KW", false);
    expect(sections.primary.map((p) => p.productId)).toEqual(["panadol"]);
    expect(sections.accessory).toEqual([]);
  });

  it("keeps a no-scope card on the confidence ladder while its siblings carry a scope", () => {
    const products = [
      product("phone", "Samsung Galaxy S25 Ultra", "primary", [kwd("Xcite", 289.9)]),
      product("legacy", "Samsung Galaxy S25 Ultra 256GB", undefined, [kwd("Jarir", 299.9)]),
      product("case", "Samsung Galaxy S25 Ultra Case", "accessory", [kwd("Eureka", 9.9)], "query_token"),
    ];
    const sections = shelfSectionsFromProducts(products, "samsung galaxy s25 ultra", "KW", false);
    expect(sections.primary.map((p) => p.productId)).toEqual(["phone", "legacy"]);
    expect(sections.accessory.map((p) => p.productId)).toEqual(["case"]);
  });
});

describe("REEA-1201 — thin-shelf honesty decision", () => {
  it("is thin when every card has one in-market retailer", () => {
    const products = [
      product("a", "Panadol", "primary", [kwd("Xcite", 1.5)]),
      product("b", "Panadrex", "primary", [kwd("Jarir", 1.7)]),
    ];
    expect(shelfHasCrossRetailerMatch(products, "KW")).toBe(false);
    expect(isThinShelf(products, "KW")).toBe(true);
  });

  it("is not thin when at least one card has two in-market retailers", () => {
    const products = [
      product("a", "Panadol", "primary", [kwd("Xcite", 1.5)]),
      product("b", "Panadrex", "primary", [kwd("Jarir", 1.7), kwd("Eureka", 1.9)]),
    ];
    expect(shelfHasCrossRetailerMatch(products, "KW")).toBe(true);
    expect(isThinShelf(products, "KW")).toBe(false);
  });

  it("ignores a cross-market row: an SAR offer is not a Kuwait comparison lane", () => {
    const products = [
      product("a", "Panadol", "primary", [
        kwd("Xcite", 1.5),
        { merchant: "Danube Home", price: 6.9, currency: "SAR", url: "https://danube.example/p", inStock: true },
      ]),
    ];
    expect(isThinShelf(products, "KW")).toBe(true);
  });

  it("an empty shelf is the empty state's job, not the thin-shelf line", () => {
    expect(isThinShelf([], "KW")).toBe(false);
  });
});

describe("REEA-1201 — EN/AR in-scope count copy", () => {
  it("names the number and the query in English", () => {
    expect(inScopeCountText("en", 1, "panadol")).toBe("1 in-scope product for “panadol”");
    expect(inScopeCountText("en", 4, "cucumber")).toBe("4 in-scope products for “cucumber”");
  });

  it("uses the Arabic dual/few/other ladder", () => {
    expect(inScopeCountText("ar", 1, "بنادول")).toContain("منتج واحد");
    expect(inScopeCountText("ar", 2, "بنادول")).toContain("منتجان");
    expect(inScopeCountText("ar", 4, "خيار")).toContain("4 منتجات");
    expect(inScopeCountText("ar", 12, "خيار")).toContain("12 منتجًا");
    expect(inScopeCountText("ar", 4, "خيار")).toContain("«خيار»");
  });
});
