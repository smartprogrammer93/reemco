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

  it("falls back to a search URL for known-dead scraped URLs", () => {
    const href = resolveOfferUrl(
      {
        merchant: "Jarir Bookstore Kuwait",
        url: "https://www.jarir.com/kw/asus-rog-strix-scope-ii",
      },
      "ASUS ROG Strix Scope II",
    );
    expect(href?.startsWith("https://www.bing.com/search?q=")).toBe(true);
    expect(href).toContain("Jarir");
  });

  it("returns null for implausible URLs so the link is hidden", () => {
    expect(resolveOfferUrl({ merchant: "X", url: "" }, "T")).toBeNull();
    expect(resolveOfferUrl({ merchant: "X", url: "nope" }, "T")).toBeNull();
    expect(resolveOfferUrl({ merchant: "X", url: "javascript:alert(1)" }, "T")).toBeNull();
  });
});
