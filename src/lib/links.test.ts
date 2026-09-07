import { describe, expect, it } from "vitest";
import { merchantSearchUrl, resolveOfferUrl } from "@/lib/links";

describe("merchantSearchUrl", () => {
  it("builds an encoded search URL", () => {
    const u = merchantSearchUrl("Jarir", "ASUS ROG Keyboard");
    expect(u.startsWith("https://www.bing.com/search?q=")).toBe(true);
    expect(u.includes("ASUS%20ROG%20Keyboard")).toBe(true);
  });
});

describe("resolveOfferUrl", () => {
  it("keeps the scraped URL for verified-healthy hosts", () => {
    expect(
      resolveOfferUrl(
        { merchant: "Xcite", url: "https://www.xcite.com/sony-wh-1000xm6" },
        "Sony WH-1000XM6",
      ),
    ).toBe("https://www.xcite.com/sony-wh-1000xm6");
  });

  it("keeps direct retailer product URLs for every adapter host (REEA-116)", () => {
    for (const offer of [
      {
        merchant: "Jarir Bookstore Kuwait",
        url: "https://www.jarir.com/?q=ASUS%20ROG%20Strix%20Scope%20II",
      },
      {
        merchant: "Amazon.eg (ships to KW)",
        url: "https://www.amazon.eg/s?k=ASUS%20ROG%20Strix%20Scope%20II",
      },
      { merchant: "Talabat", url: "https://www.talabat.com/en/kuwait" },
    ]) {
      const href = resolveOfferUrl(offer, "ASUS ROG Strix Scope II");
      expect(href.startsWith("https://www.bing.com/search")).toBe(false);
      expect(href).toBe(offer.url);
    }
  });

  it("falls back to a search URL only when no product URL was captured", () => {
    for (const url of ["", "nope", "javascript:alert(1)"]) {
      const href = resolveOfferUrl(
        { merchant: "Jarir Bookstore Kuwait", url },
        "ASUS ROG Strix Scope II",
      );
      expect(href.startsWith("https://www.bing.com/search?q=")).toBe(true);
      expect(href).toContain("Jarir");
    }
  });
});
