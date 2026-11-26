/**
 * REEA-1198 — `crossMarketHeadlineParts` is the render contract the card and
 * the PDP hero use to keep the disclosed-fallback price in one non-breaking
 * token. The joined string must stay identical to `crossMarketHeadline`, so
 * the split is purely presentational and no copy changes.
 */
import { describe, expect, it } from "vitest";
import {
  crossMarketHeadline,
  crossMarketHeadlineParts,
  type CrossMarketHeadlineParts,
} from "@/lib/market";
import type { PriceOffer } from "@/types/product";

const SAR_OFFER: PriceOffer = {
  merchant: "Danube Home",
  price: 5.8,
  currency: "SAR",
  url: "https://danube.sa/en/products/panadol-24",
  inStock: true,
  collectedAt: "2026-09-08T00:00:00.000Z",
};

const join = (p: CrossMarketHeadlineParts) => `${p.prefix}${p.price}${p.suffix}`;

describe("REEA-1198 — cross-market headline parts", () => {
  it("splits the AR sentence so the price token is the last, isolated figure", () => {
    const parts = crossMarketHeadlineParts([SAR_OFFER], "KW", "ar");
    expect(parts).not.toBeNull();
    expect(parts?.price).toBe("KD 0.47");
    expect(parts?.prefix).toBe("لا يوجد عرض في الكويت · سعر السعودية من ");
    expect(parts?.suffix).toBe("");
    expect(join(parts as CrossMarketHeadlineParts)).toBe(
      crossMarketHeadline([SAR_OFFER], "KW", "ar"),
    );
  });

  it("splits the EN sentence the same way", () => {
    const parts = crossMarketHeadlineParts([SAR_OFFER], "KW", "en");
    expect(parts?.price).toBe("KD 0.47");
    expect(parts?.prefix).toBe("No Kuwait offer · Saudi price from ");
    expect(join(parts as CrossMarketHeadlineParts)).toBe(
      crossMarketHeadline([SAR_OFFER], "KW", "en"),
    );
  });

  it("returns null exactly where the joined headline does", () => {
    expect(crossMarketHeadlineParts([SAR_OFFER], null, "en")).toBeNull();
    expect(crossMarketHeadlineParts([SAR_OFFER], "SA", "en")).toBeNull();
  });

  it("the price token never carries the sentence words (no wrap inside it)", () => {
    for (const locale of ["ar", "en"] as const) {
      const parts = crossMarketHeadlineParts([SAR_OFFER], "KW", locale);
      expect(parts?.price).not.toContain("·");
      expect(parts?.price).not.toContain("offer");
    }
  });
});
