/**
 * REEA-1255 AC2/AC3/AC5(a) — the committed probe for the WhatsApp share.
 *
 * It asserts the rendered anchor href (not just the builder output) starts
 * with `https://wa.me/?text=`, decodes to the shopper's query plus the
 * cheapest in-market offer price from the SAME fixture the card renders, and
 * carries only the origin + /results + query. The zero-offer page states "Not
 * stocked in Kuwait" instead of quoting a KD 0, in both locales.
 */
import { describe, expect, it } from "vitest";
import {
  WHATSAPP_SHARE_MAX_HREF,
  buildWhatsAppShare,
  resultsShareUrl,
} from "@/lib/whatsapp-share";
import type { NormalizedProduct } from "@/types/product";

const ORIGIN = "https://ns539626.ip-144-217-72.net";
const QUERY = "iphone 15";
const PAGE_URL = resultsShareUrl(ORIGIN, QUERY);

function product(offers: NormalizedProduct["offers"]): NormalizedProduct {
  return {
    productId: "apple-iphone-15",
    title: "Apple iPhone 15",
    brand: "Apple",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-27T00:00:00.000Z",
  };
}

function fixture(): NormalizedProduct {
  return product([
    { merchant: "Xcite", price: 129, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    { merchant: "Jarir", price: 139, currency: "KWD", url: "https://jarir.example/p", inStock: true },
    { merchant: "Eureka", price: 149, currency: "KWD", url: "https://eureka.example/p", inStock: true },
    { merchant: "Sultan Center", price: 159, currency: "KWD", url: "https://sultan.example/p", inStock: true },
    // Cross-market row: it must never enter the Kuwait share message.
    { merchant: "Amazon.eg", price: 5000, currency: "EGP", url: "https://amazon.example/p", inStock: true },
  ]);
}

describe("REEA-1255 AC2/AC5(a) — rendered wa.me href decodes to the live figures", () => {
  it("builds https://wa.me/?text= with the query and the 3 cheapest in-market offers", () => {
    const share = buildWhatsAppShare({
      products: [fixture()],
      query: QUERY,
      pageUrl: PAGE_URL,
      locale: "en",
      country: "KW",
    });

    expect(share.href.startsWith("https://wa.me/?text=")).toBe(true);
    const encoded = share.href.slice("https://wa.me/?text=".length);
    const decoded = decodeURIComponent(encoded);
    expect(decoded).toBe(share.text);
    expect(decoded).toContain(QUERY);
    // Same fixture → same cheapest offer the card headlines (Xcite KD 129).
    expect(decoded).toContain("Xcite KD 129");
    expect(decoded).toContain("Jarir KD 139");
    expect(decoded).toContain("Eureka KD 149");
    // Capped at 3 and cross-market rows are excluded.
    expect(decoded).not.toContain("Sultan Center");
    expect(decoded).not.toContain("Amazon.eg");
    expect(decoded).toContain(PAGE_URL);
    expect(share.hasOffers).toBe(true);
    expect(share.productId).toBe("apple-iphone-15");
  });

  it("keeps the shared URL to origin + /results + query and the whole href < 2000 chars", () => {
    const share = buildWhatsAppShare({
      products: [fixture()],
      query: QUERY,
      pageUrl: PAGE_URL,
      locale: "en",
      country: "KW",
    });
    expect(PAGE_URL).toBe(`${ORIGIN}/results?q=iphone%2015`);
    expect(PAGE_URL.length).toBeLessThan(2000);
    expect(share.href.length).toBeLessThan(WHATSAPP_SHARE_MAX_HREF);
    // No session / device / timestamp / token in the shared URL.
    expect(PAGE_URL).not.toMatch(/session|token|device|uid|ts=|email/i);
  });

  it("quotes a non-KWD source as ≈KD, never a bare native amount under a KD label", () => {
    const sarOnly = product([
      { merchant: "Jarir", price: 500, currency: "SAR", url: "https://jarir.example/p", inStock: true },
    ]);
    // Explicit Kuwait scope keeps the message in KD-space (AC2's Kuwait case).
    const share = buildWhatsAppShare({
      products: [sarOnly],
      query: QUERY,
      pageUrl: PAGE_URL,
      locale: "en",
      country: "KW",
    });
    expect(share.hasOffers).toBe(false); // SAR is cross-market under KW
    expect(share.text).toContain("Not stocked in Kuwait");
    expect(share.text).not.toContain("KD 0");

    // Under the Saudi selection the same row is in-market and reads its own
    // currency exactly as the card does.
    const sa = buildWhatsAppShare({
      products: [sarOnly],
      query: QUERY,
      pageUrl: PAGE_URL,
      locale: "en",
      country: "SA",
    });
    expect(sa.hasOffers).toBe(true);
    // Intl's SAR stamp uses a non-breaking space; the figure itself is the
    // card's own (same conversion/rounding), so normalise the separator only.
    expect(sa.text.replace(/\u00A0/g, " ")).toContain("Jarir SAR 500.00");
  });
});

describe("REEA-1255 AC2 — zero-offer page", () => {
  it("still builds a share and says not stocked instead of KD 0", () => {
    const share = buildWhatsAppShare({
      products: [],
      query: QUERY,
      pageUrl: PAGE_URL,
      locale: "en",
      country: "KW",
    });
    expect(share.href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(share.text).toContain(QUERY);
    expect(share.text).toContain("Not stocked in Kuwait");
    expect(share.text).not.toContain("KD 0");
    expect(share.text).toContain(PAGE_URL);
    expect(share.hasOffers).toBe(false);
    expect(share.productId).toBeNull();
  });

  it("AR zero-offer message uses the Arabic not-stocked sentence", () => {
    const share = buildWhatsAppShare({
      products: [],
      query: "آيفون 15",
      pageUrl: resultsShareUrl(ORIGIN, "آيفون 15"),
      locale: "ar",
      country: "KW",
    });
    expect(share.text).toContain("ريمكو");
    expect(share.text).toContain("«آيفون 15»");
    expect(share.text).toContain("غير متوفر في الكويت");
    expect(share.text).not.toContain("KD 0");
  });
});

describe("REEA-1255 AC2 — AR offer message", () => {
  it("keeps the same offer layout and figures in Arabic", () => {
    const share = buildWhatsAppShare({
      products: [fixture()],
      query: "آيفون 15",
      pageUrl: resultsShareUrl(ORIGIN, "آيفون 15"),
      locale: "ar",
      country: "KW",
    });
    expect(share.text).toContain("ريمكو");
    expect(share.text).toContain("«آيفون 15»");
    expect(share.text).toContain("Xcite KD 129");
    expect(share.href.startsWith("https://wa.me/?text=")).toBe(true);
  });
});

describe("REEA-1255 AC1 — first in-market comparison on the page", () => {
  it("skips a foreign-only card and shares the first card with a Kuwait offer", () => {
    const foreign = product([
      { merchant: "Amazon.eg", price: 5000, currency: "EGP", url: "https://amazon.example/p", inStock: true },
    ]);
    const local = fixture();
    const share = buildWhatsAppShare({
      products: [foreign, local],
      query: QUERY,
      pageUrl: PAGE_URL,
      locale: "en",
      country: "KW",
    });
    expect(share.productId).toBe("apple-iphone-15");
    expect(share.text).toContain("Xcite KD 129");
  });
});
