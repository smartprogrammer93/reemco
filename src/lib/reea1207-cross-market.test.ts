/**
 * REEA-1207 (Bet 7B Addition 2) — cross-market cards are recorded, never depth.
 *
 * The AC: "where only a cross-market offer exists, the card states the market
 * and converted price, and the counter records it as cross-market (not as
 * depth)". This pins the counter's arithmetic on the one integrity definition
 * the card and the weekly fold share.
 */
import { describe, expect, it } from "vitest";
import { comparisonDepthOf } from "@/lib/metrics";

const card = (offers: { merchant: string; currency: string; price: number; url: string }[]) => ({
  offers,
});

describe("REEA-1207 — cross-market-only cards are counted apart from depth", () => {
  it("counts a foreign-only card as cross-market, not multi-retailer", () => {
    const depth = comparisonDepthOf(
      [card([{ merchant: "Danube Home", currency: "SAR", price: 5.8, url: "https://d.example/1" }])],
      "KW",
    );
    expect(depth).toEqual({ cardsTotal: 1, cardsMultiRetailer: 0, cardsCrossMarket: 1 });
  });

  it("does not count a card with an in-market offer as cross-market", () => {
    const depth = comparisonDepthOf(
      [
        card([
          { merchant: "Aster Pharmacy", currency: "KWD", price: 0.9, url: "https://a.example/1" },
          { merchant: "Danube Home", currency: "SAR", price: 5.8, url: "https://d.example/1" },
        ]),
      ],
      "KW",
    );
    expect(depth.cardsMultiRetailer).toBe(0);
    expect(depth.cardsCrossMarket).toBe(0);
  });

  it("counts two in-market retailers as depth and never as cross-market", () => {
    const depth = comparisonDepthOf(
      [
        card([
          { merchant: "Xcite", currency: "KWD", price: 3.9, url: "https://x.example/1" },
          { merchant: "Blink", currency: "KWD", price: 3.5, url: "https://b.example/1" },
        ]),
      ],
      "KW",
    );
    expect(depth.cardsMultiRetailer).toBe(1);
    expect(depth.cardsCrossMarket).toBe(0);
  });
});
