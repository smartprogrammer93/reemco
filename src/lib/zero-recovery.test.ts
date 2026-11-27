/**
 * REEA-1247 — nearest in-market recovery for the zero-offer page.
 *
 * These pins are the AC4/AC5 contract on the pure selector: only real live rows
 * from the run may become recovery items, each must name the query term it
 * actually carries, each must return at least one in-market (Kuwait) offer, and
 * foreign-only answers are separated instead of being called a Kuwait match.
 */
import { describe, expect, it } from "vitest";
import { RECOVERY_CAP, matchedTermsFor, nearestMatches } from "@/lib/zero-recovery";
import type { NormalizedProduct } from "@/types/product";

function product(
  id: string,
  title: string,
  offers: NormalizedProduct["offers"],
): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-27T00:00:00.000Z",
  };
}

const kwd = (merchant: string, price: number): NormalizedProduct["offers"][number] => ({
  merchant,
  price,
  currency: "KWD",
  url: `https://${merchant.toLowerCase()}.example/p`,
  inStock: true,
});

const sar = (merchant: string, price: number): NormalizedProduct["offers"][number] => ({
  merchant,
  price,
  currency: "SAR",
  url: `https://${merchant.toLowerCase()}.example/p`,
  inStock: true,
});

describe("matchedTermsFor — the term a recovery item is labelled with", () => {
  it("names the query token the title actually carries", () => {
    expect(matchedTermsFor("iphone 17 pro case", "Case for iPhone 17 Pro")).toEqual([
      "iphone",
      "17",
      "pro",
      "case",
    ]);
  });

  it("keeps model containment (xm6 answers WH-1000XM6)", () => {
    expect(matchedTermsFor("xm6 ear pads", "Sony WH-1000XM6 Wireless Headphones")).toContain("xm6");
  });

  it("ignores function words so 'no' cannot match HONOR", () => {
    expect(matchedTermsFor("xyzzy no such thing", "HONOR Pad 20 Tablet")).toEqual([]);
    expect(matchedTermsFor("xyzzy no such thing", "Fubbles No-Spill Bubble Machine")).toEqual([]);
  });

  it("matches an Arabic query token in an Arabic title", () => {
    expect(matchedTermsFor("غسالة", "غسالة LG أوتوماتيك")).toContain("غسالة");
  });
});

describe("nearestMatches — AC4 in-market recovery", () => {
  it("returns only in-market matches, each with a matched term and a Kuwait offer", () => {
    const { inMarket, foreign } = nearestMatches("dyson airwrap case", [
      product("airwrap", "Dyson Airwrap i.d. Multi-styler", [kwd("Yousifi", 139.9), kwd("Eureka", 139.95)]),
      product("bose", "Bose Silicone Case Cover for QuietComfort Earbuds", [kwd("Yousifi", 9.95)]),
      product("book", "Bizzy Bear: Snow Fun", [sar("Jarir", 29)]),
    ]);
    expect(inMarket.map((i) => i.product.productId)).toEqual(["airwrap", "bose"]);
    expect(inMarket[0].matchedTerm).toBe("dyson");
    expect(inMarket[0].price).toBe(139.9);
    expect(inMarket[0].currency).toBe("KWD");
    expect(inMarket.every((i) => i.offers.every((o) => o.currency === "KWD"))).toBe(true);
    // The children's book carries no query term — it is not padded in.
    expect(inMarket.map((i) => i.product.productId)).not.toContain("book");
    expect(foreign).toEqual([]);
  });

  it("caps recovery at five and ranks the nearer (more matched terms) first", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      product(`p-${i}`, i === 7 ? "Dyson Airwrap case i.d. Straight+Wavy" : `Dyson Airwrap ${i}`, [kwd("Yousifi", 100 + i)]),
    );
    const { inMarket } = nearestMatches("dyson airwrap case", items);
    expect(inMarket).toHaveLength(RECOVERY_CAP);
    expect(inMarket[0].product.productId).toBe("p-7");
    expect(inMarket[0].matchedTerms.length).toBe(3);
  });

  it("separates a foreign-only answer instead of calling it a Kuwait match", () => {
    const { inMarket, foreign } = nearestMatches("sony wh-1000xm6 ear pads", [
      product("sony-a", "Sony WI-C100 In-Ear Earphones", [sar("Jarir", 99)]),
      product("sony-b", "Sony WF-C510 Earbuds", [sar("Jarir", 219)]),
      product("dyson", "Dyson Airwrap", [kwd("Yousifi", 139.9)]),
    ]);
    expect(inMarket).toEqual([]);
    expect(foreign.map((f) => f.product.productId)).toEqual(["sony-a", "sony-b"]);
    expect(foreign[0].market).toBe("SA");
    expect(foreign[0].matchedTerm).toBe("sony");
  });

  it("keeps an item with both a Kuwait and a foreign offer on the in-market side", () => {
    const { inMarket, foreign } = nearestMatches("iphone 17 pro", [
      product("phone", "Apple iPhone 17 Pro", [sar("Jarir", 6699), kwd("Xcite", 364.9)]),
    ]);
    expect(inMarket).toHaveLength(1);
    expect(inMarket[0].price).toBe(364.9);
    expect(foreign).toEqual([]);
  });

  it("returns nothing when no row carries a query term (no unrelated padding)", () => {
    const { inMarket, foreign } = nearestMatches("xyzzy no such thing", [
      product("honor", "HONOR Pad 20 Tablet", [kwd("Sultan Center", 0.175)]),
      product("bizzy", "Bizzy Bear: Snow Fun", [sar("Jarir", 29)]),
      product("legion", "Lenovo Legion Go Gen 2 Gaming Console", [kwd("Quadra Stores", 519.9)]),
    ]);
    expect(inMarket).toEqual([]);
    expect(foreign).toEqual([]);
  });
});
