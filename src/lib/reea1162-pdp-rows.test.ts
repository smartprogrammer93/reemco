/**
 * REEA-1162 — the product page's offer table counts DISTINCT retailers and
 * renders one row per distinct retailer offer.
 *
 * Live defect (REEA-1118 on d9f31b54): the collect run fans out one scrape per
 * listing the merged card carries, so a retailer's several colourway listings
 * at one price produced duplicate rows and the count line read offers.length:
 *  - HD16  "All offers · 5 retailers" listed Eureka ×5 + Zayoom;
 *  - Tune 500 "4 retailers" listed Jarir + Danube Home ×3;
 *  - DualSense "6 retailers" listed Wibi ×2, Astore ×2, Eureka ×2.
 * The card→PDP continuity contract (REEA-1140 D2) still requires every card
 * price to appear on the PDP at the same price, so rows at DIFFERENT prices
 * from one retailer stay distinct offers.
 */
import { describe, expect, it } from "vitest";
import { dedupeRetailerOfferRows, distinctRetailerCount } from "@/lib/offer-rows";

interface Row {
  merchant: string;
  currency: string;
  price: number;
  inStock: boolean;
  url: string;
}

function row(merchant: string, price: number, url: string, inStock = true): Row {
  return { merchant, currency: "KWD", price, inStock, url };
}

describe("REEA-1162 — PDP rows are one per distinct retailer offer", () => {
  it("collapses HD16's five same-price Eureka rows to one, leaving 2 retailers", () => {
    const rows = [
      row("Eureka", 119.95, "https://eureka.example/hd16-apricot"),
      row("Eureka", 119.95, "https://eureka.example/hd16-amber"),
      row("Eureka", 119.95, "https://eureka.example/hd16-blue"),
      row("Eureka", 119.95, "https://eureka.example/hd16-red"),
      row("Eureka", 119.95, "https://eureka.example/hd16-pink"),
      row("Zayoom", 139, "https://zayoom.example/hd16-pink"),
    ];
    const deduped = dedupeRetailerOfferRows(rows);
    expect(deduped).toHaveLength(2);
    expect(distinctRetailerCount(deduped)).toBe(2);
    // Both card prices survive at the same figure (REEA-1140 D2).
    expect(deduped.map((r) => [r.merchant, r.price])).toEqual([
      ["Eureka", 119.95],
      ["Zayoom", 139],
    ]);
  });

  it("collapses the DualSense duplicate rows to one per retailer", () => {
    const rows = [
      row("Wibi", 20.9, "https://wibi.example/ds-white"),
      row("Wibi", 20.9, "https://wibi.example/ds-white-2"),
      row("Blink", 25.9, "https://blink.example/ds"),
      row("Astore", 28.9, "https://astore.example/ds-grey"),
      row("Astore", 28.9, "https://astore.example/ds-black"),
      row("Eureka", 30.25, "https://eureka.example/ds-green"),
      row("Eureka", 30.25, "https://eureka.example/ds-green-2"),
    ];
    const deduped = dedupeRetailerOfferRows(rows);
    expect(deduped).toHaveLength(4);
    expect(distinctRetailerCount(deduped)).toBe(4);
    expect(deduped.map((r) => r.merchant)).toEqual(["Wibi", "Blink", "Astore", "Eureka"]);
  });

  it("keeps genuinely different prices from one retailer as distinct offers", () => {
    const rows = [
      row("Eureka", 119.95, "https://eureka.example/hd16-apricot"),
      row("Eureka", 139, "https://eureka.example/hd16-pink"),
      row("Zayoom", 139, "https://zayoom.example/hd16-pink"),
    ];
    const deduped = dedupeRetailerOfferRows(rows);
    // Two real prices from Eureka are two offers; the retailer count is 2.
    expect(deduped).toHaveLength(3);
    expect(distinctRetailerCount(deduped)).toBe(2);
  });

  it("prefers the in-stock occurrence of a duplicated row", () => {
    const rows = [
      row("Xcite", 99, "https://xcite.example/a", false),
      row("Xcite", 99, "https://xcite.example/b", true),
    ];
    const deduped = dedupeRetailerOfferRows(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].url).toBe("https://xcite.example/b");
    expect(deduped[0].inStock).toBe(true);
  });

  it("counts distinct retailers case/whitespace-insensitively and skips blanks", () => {
    expect(
      distinctRetailerCount([
        { merchant: "Eureka" },
        { merchant: " eureka " },
        { merchant: "Zayoom" },
        { merchant: "" },
      ]),
    ).toBe(2);
  });
});
