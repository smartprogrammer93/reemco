import { describe, it, expect } from "vitest";
import { offerSchema, assertFetchAllowed } from "./offer-schema";

const baseOffer = {
  merchantName: "ExampleMart",
  url: "https://shop.example.com/p/123",
  price: 129.99,
  currency: "USD",
  availability: "in_stock",
  sourceUrl: "https://shop.example.com/p/123",
  fetchedAt: "2026-09-04T22:00:00Z",
  scraperRunId: "run-2026-09-04-01",
};

describe("offerSchema (F3)", () => {
  it("accepts a well-formed offer", () => {
    expect(offerSchema.parse(baseOffer).price).toBe(129.99);
  });

  it("rejects negative prices", () => {
    expect(offerSchema.safeParse({ ...baseOffer, price: -1 }).success).toBe(false);
  });

  it("rejects corrupt/absurd prices", () => {
    expect(offerSchema.safeParse({ ...baseOffer, price: 99_999_999 }).success).toBe(false);
    expect(offerSchema.safeParse({ ...baseOffer, price: "129.99" }).success).toBe(false);
  });

  it("rejects non-ISO-4217 currency", () => {
    expect(offerSchema.safeParse({ ...baseOffer, currency: "dollars" }).success).toBe(false);
  });

  it("strips control characters from merchant name", () => {
    const parsed = offerSchema.parse({ ...baseOffer, merchantName: "Evil\u0000Mart<script>" });
    expect(parsed.merchantName).toBe("EvilMart<script>");
  });

  it("rejects javascript: URLs (class fix shared with F1)", () => {
    expect(offerSchema.safeParse({ ...baseOffer, url: "javascript:alert(1)" }).success).toBe(false);
    expect(offerSchema.safeParse({ ...baseOffer, url: "https://a@b@evil.com" }).success).toBe(false);
  });

  it("requires provenance (sourceUrl + fetchedAt)", () => {
    const { sourceUrl, fetchedAt, ...missing } = baseOffer;
    expect(offerSchema.safeParse(missing).success).toBe(false);
  });
});

describe("assertFetchAllowed (F3 SSRF guard)", () => {
  const allowlist = ["shop.example.com", "mart.example.org"] as const;

  it("allows configured retailer domains and subdomains", () => {
    expect(assertFetchAllowed("https://shop.example.com/p/1", allowlist).hostname).toBe("shop.example.com");
    expect(assertFetchAllowed("https://deals.shop.example.com/p", allowlist).hostname).toBe("deals.shop.example.com");
  });

  it("refuses lookalike hosts not in the allowlist", () => {
    expect(() => assertFetchAllowed("https://evil-shop.example.com.attacker.net/p", allowlist)).toThrow();
    expect(() => assertFetchAllowed("https://attacker.net/", allowlist)).toThrow();
  });

  it("refuses non-http(s) and metadata-style targets", () => {
    expect(() => assertFetchAllowed("file:///etc/passwd", allowlist)).toThrow();
    expect(() => assertFetchAllowed("ftp://shop.example.com/", allowlist)).toThrow();
  });
});
