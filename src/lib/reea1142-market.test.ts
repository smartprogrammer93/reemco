/**
 * REEA-1142 — market-scope unit pins.
 *
 * The defect: a Saudi storefront's SAR offer (danube.sa) rendered on the
 * Kuwait surface with no market label and could win the "best effective
 * price" headline after the ≈KD conversion. These pins fix the contract the
 * accepted policy requires:
 *  - every offer carries the market its own storefront serves;
 *  - a cross-market offer is labeled ("Saudi price · ≈KD X") and never
 *    eligible for the local headline / "Best price" claim;
 *  - when a card has no local offer the honest "No Kuwait offer · Saudi
 *    price from KD X" line renders instead (EN+AR);
 *  - the market-scoped order puts local offers first, so a converted figure
 *    cannot lead the row list.
 */
import { describe, expect, it } from "vitest";
import {
  cheapestCrossMarketOffer,
  countCrossMarketOffers,
  crossMarketHeadline,
  crossMarketRowLabel,
  headlineOfferFor,
  isCrossMarketOffer,
  marketScope,
  marketStockLabel,
  marketViewScope,
  offerMarket,
  scopeProductsByMarket,
  sortOffersByMarket,
} from "@/lib/market";
import { comparisonMerchantCount } from "@/lib/offer-integrity";
import { visibleShelfOffers } from "@/lib/results-offers";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

const KW_OFFER: PriceOffer = {
  merchant: "Xcite",
  price: 0.75,
  currency: "KWD",
  url: "https://xcite.example/p",
  inStock: true,
};
const SAR_OFFER: PriceOffer = {
  merchant: "Danube Home",
  price: 5.8,
  currency: "SAR",
  url: "https://danube.sa/en/products/p",
  inStock: true,
};
const SAR_CHEAPER: PriceOffer = {
  merchant: "Danube Home",
  price: 4.5,
  currency: "SAR",
  url: "https://danube.sa/en/products/cheap",
  inStock: true,
};

describe("market tags (AC3)", () => {
  it("derives the storefront market from the served currency", () => {
    expect(offerMarket("KWD")).toBe("KW");
    expect(offerMarket("SAR")).toBe("SA");
    expect(offerMarket("EGP")).toBe("EG");
    expect(offerMarket("USD")).toBeNull();
  });

  it("marks a SAR listing cross-market on a Kuwait surface", () => {
    expect(isCrossMarketOffer(SAR_OFFER, "KW")).toBe(true);
    expect(isCrossMarketOffer(KW_OFFER, "KW")).toBe(false);
    expect(isCrossMarketOffer(KW_OFFER, "SA")).toBe(true);
  });

  it("defaults to the home market Kuwait when no selection is stated", () => {
    expect(marketScope(null)).toBe("KW");
    expect(marketScope("SA")).toBe("SA");
    // REEA-1177 — undefined is the unstated default (KW); explicit null is ALL.
    expect(marketViewScope(undefined)).toBe("KW");
    expect(marketViewScope(null)).toBeNull();
  });

  it("stamps every offer with its market and scopes the shelf to the selected market (Bet 6d)", () => {
    const product: NormalizedProduct = {
      productId: "p1",
      title: "Panadol",
      brand: "",
      offers: [KW_OFFER, SAR_OFFER],
      coupons: [],
      variations: [],
      alternatives: [],
    };
    // A product with a Kuwait offer renders Kuwait offers only on the KW
    // shelf; the Saudi row is the AC 6d-3 exception only when no local offer.
    const [scoped] = scopeProductsByMarket([product], "KW");
    expect(scoped.offers).toHaveLength(1);
    expect(scoped.offers.map((o) => o.market)).toEqual(["KW"]);
    // No in-market offer: the cross-market rows survive, tagged.
    const [crossOnly] = scopeProductsByMarket([{ ...product, offers: [SAR_OFFER] }], "KW");
    expect(crossOnly.offers).toHaveLength(1);
    expect(crossOnly.offers.map((o) => o.market)).toEqual(["SA"]);
    // The explicit ALL view keeps the whole tagged set.
    const [all] = scopeProductsByMarket([product], null);
    expect(all.offers).toHaveLength(2);
    expect(all.offers.map((o) => o.market)).toEqual(["KW", "SA"]);
  });
});

describe("market-scoped ordering (AC2)", () => {
  it("puts the local offer first even when a converted cross-market offer is cheaper", () => {
    const sorted = sortOffersByMarket([SAR_CHEAPER, KW_OFFER], null, "KW");
    expect(sorted.map((o) => o.merchant)).toEqual(["Xcite", "Danube Home"]);
  });

  it("keeps the cross-market group in its own price order", () => {
    const sorted = sortOffersByMarket([SAR_OFFER, SAR_CHEAPER], null, "KW");
    expect(sorted.map((o) => o.price)).toEqual([4.5, 5.8]);
  });

  it("selects the cheapest LOCAL in-stock offer as the headline", () => {
    expect(headlineOfferFor([SAR_CHEAPER, KW_OFFER], "KW")?.merchant).toBe("Xcite");
  });

  it("returns no local headline when the card has only cross-market offers", () => {
    expect(headlineOfferFor([SAR_CHEAPER, SAR_OFFER], "KW")).toBeNull();
    expect(cheapestCrossMarketOffer([SAR_CHEAPER, SAR_OFFER], "KW")?.price).toBe(4.5);
  });

  it("excludes flagged offers from the headline", () => {
    const flagged: PriceOffer = {
      ...KW_OFFER,
      price: 0.1,
      sanity: { status: "flagged", reason: "outlier_low" },
    };
    expect(headlineOfferFor([flagged, KW_OFFER], "KW")?.price).toBe(0.75);
  });
});

describe("cross-market copy (AC1/AC2)", () => {
  it("names the market on the row with the converted ≈KD reference", () => {
    const row = crossMarketRowLabel(SAR_OFFER, "KW", "en");
    expect(row?.market).toBe("Saudi price");
    expect(row?.price).toBe("≈KD 0.47");
  });

  it("has the Arabic equivalent", () => {
    const row = crossMarketRowLabel(SAR_OFFER, "KW", "ar");
    expect(row?.market).toBe("سعر السعودية");
    expect(row?.price).toBe("≈KD 0.47");
  });

  it("renders the honest no-local-offer headline EN+AR", () => {
    const en = crossMarketHeadline([SAR_CHEAPER], "KW", "en");
    expect(en).toBe("No Kuwait offer · Saudi price from KD 0.37");
    const ar = crossMarketHeadline([SAR_CHEAPER], "KW", "ar");
    expect(ar).toBe("لا يوجد عرض في الكويت · سعر السعودية من KD 0.37");
  });

  it("returns null when a local offer exists", () => {
    expect(crossMarketHeadline([KW_OFFER, SAR_CHEAPER], "KW", "en")).toBeNull();
  });

  it("labels the cross-market stock badge, never a Kuwait Verified claim", () => {
    expect(marketStockLabel("SA", "en")).toBe("KSA stock");
    expect(marketStockLabel("SA", "ar")).toBe("مخزون السعودية");
  });
});

describe("aggregate counter input (AC5)", () => {
  it("counts only cross-market offers on the served set", () => {
    expect(countCrossMarketOffers([KW_OFFER, SAR_OFFER, SAR_CHEAPER], "KW")).toBe(2);
    expect(countCrossMarketOffers([KW_OFFER], "KW")).toBe(0);
    expect(countCrossMarketOffers([KW_OFFER, SAR_OFFER], "SA")).toBe(1);
  });
});

describe("REEA-1238 AC 7B-2b — a cross-market comparison pair renders both retailers", () => {
  const pair: NormalizedProduct = {
    productId: "panadol-extra",
    title: "Panadol Extra Tablets 48's",
    brand: "Panadol",
    offers: [KW_OFFER, SAR_OFFER],
    coupons: [],
    variations: [],
    alternatives: [],
  };

  it("keeps the tagged other-market row on the card the shelf classified as a pair", () => {
    const [scoped] = scopeProductsByMarket(
      [{ ...pair, comparisonAcrossMarkets: true }],
      "KW",
    );
    expect(scoped.offers.map((o) => o.merchant)).toEqual(["Xcite", "Danube Home"]);
    expect(scoped.offers.map((o) => o.market)).toEqual(["KW", "SA"]);
  });

  it("still scopes an ordinary card to the selected market (REEA-1177 AC 6d-3)", () => {
    const [scoped] = scopeProductsByMarket([pair], "KW");
    expect(scoped.offers.map((o) => o.merchant)).toEqual(["Xcite"]);
  });

  it("the visible rows carry both retailers while the headline and from figure stay local", () => {
    const view = visibleShelfOffers({ ...pair, comparisonAcrossMarkets: true }, "KW");
    expect(view.best?.merchant).toBe("Xcite");
    expect(view.localBest?.merchant).toBe("Xcite");
    expect(view.crossBest?.merchant).toBe("Danube Home");
    expect(view.cardRows.map((o) => o.merchant)).toEqual(["Xcite", "Danube Home"]);
    // The in-market comparison count still reads the Kuwait lane only.
    expect(comparisonMerchantCount(view.all, "KW")).toBe(1);
  });
});
