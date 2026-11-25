/**
 * REEA-1147 — Bet 4.1 merge rule: the served results page compares the MODEL
 * a shopper searched, not one retailer's capacity tier.
 *
 * Live defect (served stamp 33be78fb8e69, W48 panel): Xcite carried one
 * capacity, Wibi another and Eureka a third of the same S25 Ultra, so the page
 * rendered one single-retailer card per tier and s25 ultra measured 0/5 depth.
 * The fold is query-time aggregation over fetched titles only — no catalog.
 */
import { describe, expect, it } from "vitest";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

function hit(title: string, merchant: string, price: number, currency = "KWD"): SearchHit {
  return {
    title,
    merchant,
    price,
    currency,
    url: `https://retailer.example/${merchant}/${encodeURIComponent(title)}`,
    inStock: true,
    country: currency === "SAR" ? "SA" : currency === "EGP" ? "EG" : "KW",
  };
}

const kwdMerchants = (offers: { merchant: string; currency: string }[]): string[] => [
  ...new Set(offers.filter((o) => o.currency === "KWD").map((o) => o.merchant)),
];

describe("REEA-1147 — a model family whose tiers are all single-store folds into one comparison card", () => {
  const hits = [
    hit("Samsung Galaxy S25 Ultra 256GB Black", "Xcite", 289.9),
    hit("Samsung Galaxy S25 Ultra 512GB Silver", "Wibi", 339.9),
    hit("Samsung Galaxy S25 Ultra 1TB Black", "Eureka", 419.9),
  ];

  it("renders ONE card carrying all three in-market retailers", () => {
    const products = groupHits("samsung galaxy s25 ultra", hits, true, undefined, true);
    expect(products).toHaveLength(1);
    const card = products[0];
    expect(kwdMerchants(card.offers).sort()).toEqual(["Eureka", "Wibi", "Xcite"]);
    // The card names the model, not one tier's spelling.
    expect(card.title).toBe("Samsung Galaxy S25 Ultra");
  });

  it("keeps each store's capacity visible as a row label", () => {
    const products = groupHits("samsung galaxy s25 ultra", hits, true, undefined, true);
    const labels = products[0].offers.map((o) => o.label ?? "");
    expect(labels).toEqual(["256 GB", "512 GB", "1 TB"]);
  });

  it("does not fold genuinely different model lines (Pro vs Pro Max)", () => {
    const products = groupHits("iphone 17 pro", [
      hit("Apple iPhone 17 Pro 256GB Black", "Xcite", 429.9),
      hit("Apple iPhone 17 Pro Max 256GB Black", "Wibi", 479.9),
    ], true, undefined, true);
    expect(products).toHaveLength(2);
  });

  it("never folds an accessory into the device card", () => {
    const products = groupHits("samsung galaxy s25 ultra", [
      hit("Samsung Galaxy S25 Ultra 256GB Black", "Xcite", 289.9),
      hit("Samsung Galaxy S25 Ultra 512GB Silver", "Wibi", 339.9),
      hit("Samsung Galaxy S25 Ultra Silicone Case Light Blue", "Eureka", 4.9),
    ], true, undefined, true);
    expect(products).toHaveLength(2);
    const device = products.find((p) => !/case/i.test(p.title))!;
    expect(kwdMerchants(device.offers).sort()).toEqual(["Wibi", "Xcite"]);
  });
});

describe("REEA-1147 — an already-comparing tier is never folded away", () => {
  it("keeps the multi-store tier and the single-store tier as separate cards", () => {
    const products = groupHits("samsung galaxy s25 ultra", [
      hit("Samsung Galaxy S25 Ultra 256GB Black", "Xcite", 289.9),
      hit("Samsung Galaxy S25 Ultra 256GB Black", "Wibi", 295.9),
      hit("Samsung Galaxy S25 Ultra 512GB Silver", "Eureka", 339.9),
    ], true, undefined, true);
    expect(products).toHaveLength(2);
    const multi = products.find((p) => kwdMerchants(p.offers).length === 2)!;
    expect(kwdMerchants(multi.offers).sort()).toEqual(["Wibi", "Xcite"]);
    const single = products.find((p) => kwdMerchants(p.offers).length === 1)!;
    expect(kwdMerchants(single.offers)).toEqual(["Eureka"]);
  });

  it("the exact-SKU primitive (flag off) keeps its REEA-254 tier split", () => {
    const products = groupHits("samsung galaxy s25 ultra", [
      hit("Samsung Galaxy S25 Ultra 256GB Black", "Xcite", 289.9),
      hit("Samsung Galaxy S25 Ultra 512GB Silver", "Wibi", 339.9),
    ]);
    expect(products).toHaveLength(2);
  });
});
