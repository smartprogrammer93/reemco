/**
 * REEA-541 Bet B — plain-text share-summary builder.
 * AC1: exact on-screen sort order (sortOffers), cap at first 5 offers, honors
 *      the country selection through formatCountryPrice, existing price
 *      formatting and the REEA-65 freshness bucket label on the tail.
 * AC2: same layout EN + AR (same shape, locale words from the table).
 */
import { describe, expect, it } from "vitest";
import { buildShareSummary, SUMMARY_MAX_OFFERS } from "@/lib/share-summary";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

// Fixed clock: 2026-09-12T12:00:00Z (same discipline as freshness.test.ts).
const NOW = Date.parse("2026-09-12T12:00:00Z");
const THREE_HOURS = "2026-09-12T09:00:00Z";

function offer(
  merchant: string,
  price: number,
  extra: Partial<PriceOffer> = {},
): PriceOffer {
  return { merchant, price, currency: "KWD", url: `https://${merchant}.example/p`, inStock: true, ...extra };
}

function productWith(offers: PriceOffer[], scrapedAt: string | null = THREE_HOURS): NormalizedProduct {
  return {
    productId: "iphone-17-pro",
    title: "iPhone 17 Pro",
    brand: "Apple",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    ...(scrapedAt !== null ? { scrapedAt } : {}),
  };
}

describe("REEA-541 AC1 — one line, on-screen order, existing formatting", () => {
  const product = productWith([
    offer("Eureka", 4250),
    offer("Jarir", 4199),
    offer("Xcite", 4099),
    offer("Sultan Center", 4300, { inStock: false }),
  ]);

  it("copies the exact rendered line: sortOffers order + KD figures + verified bucket label", () => {
    expect(buildShareSummary(product, { locale: "en", now: NOW })).toBe(
      "iPhone 17 Pro — best now: Xcite KD 4,099 · Jarir KD 4,199 · Eureka KD 4,250 · Sultan Center KD 4,300 · verified 3h ago",
    );
  });

  it("in-stock rows lead the order even over a cheaper out-of-stock listing (sortOffers contract)", () => {
    const p = productWith([
      offer("CheapOOS", 999, { inStock: false }),
      offer("Xcite", 4099),
      offer("Jarir", 4199),
    ]);
    expect(buildShareSummary(p, { locale: "en", now: NOW })).toBe(
      "iPhone 17 Pro — best now: Xcite KD 4,099 · Jarir KD 4,199 · CheapOOS KD 999 · verified 3h ago",
    );
  });

  it("caps at the first five offers of the sorted order", () => {
    expect(SUMMARY_MAX_OFFERS).toBe(5);
    const p = productWith([
      offer("M7", 700),
      offer("M1", 100),
      offer("M2", 200),
      offer("M3", 300),
      offer("M4", 400),
      offer("M5", 500),
      offer("M6", 600),
    ]);
    const line = buildShareSummary(p, { locale: "en", now: NOW });
    expect(line).toBe(
      "iPhone 17 Pro — best now: M1 KD 100 · M2 KD 200 · M3 KD 300 · M4 KD 400 · M5 KD 500 · verified 3h ago",
    );
    expect(line).not.toContain("M6");
  });
});

describe("REEA-541 AC1 — selections and freshness honored", () => {
  const kwdOnly = productWith([offer("Xcite", 4099)]);

  it("country selection decides the lead figure, exactly like the rendered rows", () => {
    // No selection: the native KD figure leads.
    expect(buildShareSummary(kwdOnly, { locale: "en", now: NOW })).toContain("Xcite KD 4,099");
    // SA selection: the lead reads in SAR through the same shared formatter
    // (Intl stamps may carry a non-breaking space — normalize before matching).
    const sa = buildShareSummary(kwdOnly, { locale: "en", country: "SA", now: NOW }).replace(/\s+/g, " ");
    expect(sa).toMatch(/Xcite ≈SAR 50,232\.84/);
  });

  it("a missing scrape stamp omits the verified tail — never a fabricated date", () => {
    const p = productWith([offer("Xcite", 4099)], null);
    expect(buildShareSummary(p, { locale: "en", now: NOW })).toBe(
      "iPhone 17 Pro — best now: Xcite KD 4,099",
    );
  });

  it("a stale (>7d) stamp keeps the explicit outdated suffix", () => {
    const p = productWith([offer("Xcite", 4099)], "2026-09-04T12:00:00Z");
    expect(buildShareSummary(p, { locale: "en", now: NOW })).toContain(
      "verified 8d ago · may be outdated",
    );
  });
});

describe("REEA-541 AC2 — same layout EN + AR", () => {
  const product = productWith([offer("Xcite", 4099), offer("Jarir", 4199)]);

  it("Arabic uses the table words with the identical separator layout and order", () => {
    const en = buildShareSummary(product, { locale: "en", now: NOW });
    const ar = buildShareSummary(product, { locale: "ar", now: NOW });
    expect(ar).toBe(
      "iPhone 17 Pro — أفضل سعر الآن: Xcite KD 4,099 · Jarir KD 4,199 · تم التحقق 3h ago",
    );
    // Same layout: same number of ' · ' segments and the same offer order.
    expect(ar.split(" · ").length).toBe(en.split(" · ").length);
    expect(ar.split(" · ").slice(1, -1)).toEqual(en.split(" · ").slice(1, -1));
  });
});
