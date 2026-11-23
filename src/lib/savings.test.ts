/**
 * REEA-1070 AC7 — savings baseline arithmetic and provenance.
 *
 * The UI may only claim a save when the server hands it struck − current
 * (±0.01) together with the retailer/listed price that figure is measured
 * against. These pins keep the arithmetic exact and the baseline honest.
 */
import { describe, expect, it } from "vitest";
import { roundMoney, savingsFor } from "@/lib/savings";

describe("savingsFor (REEA-1070 AC7)", () => {
  it("computes struck − current to the fils with a named baseline", () => {
    const savings = savingsFor({
      merchant: "Xcite",
      price: 189.9,
      currency: "KWD",
      url: "https://www.xcite.com/iphone-17-pro/p",
      wasPrice: 214,
      collectedAt: "2026-11-23T00:00:00.000Z",
    });
    expect(savings).not.toBeNull();
    expect(savings!.amount).toBe(24.1);
    expect(savings!.struckPrice).toBe(214);
    expect(savings!.currentPrice).toBe(189.9);
    expect(savings!.baseline).toEqual({
      merchant: "Xcite",
      listedPrice: 214,
      currency: "KWD",
      kind: "was_price",
      observedAt: "2026-11-23T00:00:00.000Z",
      url: "https://www.xcite.com/iphone-17-pro/p",
    });
  });

  it("keeps the three design-pack arithmetic examples exact", () => {
    expect(savingsFor({ merchant: "A", price: 189.9, currency: "KWD", wasPrice: 214 })!.amount).toBe(24.1);
    expect(savingsFor({ merchant: "B", price: 214.9, currency: "KWD", wasPrice: 239 })!.amount).toBe(24.1);
    expect(savingsFor({ merchant: "C", price: 329, currency: "KWD", wasPrice: 349 })!.amount).toBe(20);
  });

  it("rounds binary-float noise instead of leaking it into the pill", () => {
    expect(roundMoney(10.1 - 9.2)).toBe(0.9);
    expect(savingsFor({ merchant: "A", price: 9.2, currency: "KWD", wasPrice: 10.1 })!.amount).toBe(0.9);
  });

  it("claims nothing without a usable compare-at price", () => {
    expect(savingsFor({ merchant: "A", price: 100, currency: "KWD" })).toBeNull();
    expect(savingsFor({ merchant: "A", price: 100, currency: "KWD", wasPrice: 100 })).toBeNull();
    expect(savingsFor({ merchant: "A", price: 100, currency: "KWD", wasPrice: 99 })).toBeNull();
    expect(savingsFor({ merchant: "A", price: Number.NaN, currency: "KWD", wasPrice: 120 })).toBeNull();
  });
});
