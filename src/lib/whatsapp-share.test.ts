/**
 * REEA-1255 AC2/AC3/AC5(a) — the committed probe for the WhatsApp share
 * payload, implemented to the REEA-1257 spec §3.
 *
 * It asserts the anchor href starts with `https://wa.me/?text=`, decodes to
 * the rendered product title + up to 3 in-stock in-market offers (cheapest
 * first, one line per retailer) + the PDP URL, and that every price string is
 * the same `formatCountryPrice` figure the surface renders. The zero-offer
 * product page says "not stocked in Kuwait right now" instead of KD 0. The
 * shared URL is origin + /product/<id> (+ the existing ?q=), under 2,000 chars.
 */
import { describe, expect, it } from "vitest";
import {
  WHATSAPP_SHARE_MAX_HREF,
  buildPdpShareUrl,
  buildWhatsAppShare,
  capShareTitle,
} from "@/lib/whatsapp-share";
import { formatCountryPrice } from "@/lib/format";
import type { NormalizedProduct } from "@/types/product";

const ORIGIN = "https://ns539626.ip-144-217-72.net";
const QUERY = "iphone 15";
const PDP_URL = buildPdpShareUrl(ORIGIN, "apple-iphone15", QUERY);

function product(offers: NormalizedProduct["offers"], title = "Apple iPhone 15, 128GB"): NormalizedProduct {
  return {
    productId: "apple-iphone15",
    title,
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
    { merchant: "Xcite", price: 204.9, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    // Duplicate retailer: the cheaper Yousifi variant must be the one line.
    { merchant: "Yousifi", price: 205.9, currency: "KWD", url: "https://yousifi.example/p2", inStock: true },
    { merchant: "Yousifi", price: 204.9, currency: "KWD", url: "https://yousifi.example/p1", inStock: true },
    { merchant: "Eureka", price: 239.9, currency: "KWD", url: "https://eureka.example/p", inStock: true },
    // Cross-market and out-of-stock rows never ride the message.
    { merchant: "Jarir", price: 500, currency: "SAR", url: "https://jarir.example/p", inStock: true },
    { merchant: "Blink", price: 199, currency: "KWD", url: "https://blink.example/p", inStock: false },
  ]);
}

describe("REEA-1255 AC2/AC5(a) — the rendered wa.me payload", () => {
  it("builds https://wa.me/?text= with the title, the 3 cheapest in-stock retailers and the PDP URL", () => {
    const share = buildWhatsAppShare({
      product: fixture(),
      query: QUERY,
      origin: ORIGIN,
      locale: "en",
      country: "KW",
    });

    expect(share.href.startsWith("https://wa.me/?text=")).toBe(true);
    const decoded = decodeURIComponent(share.href.slice("https://wa.me/?text=".length));
    expect(decoded).toBe(share.message);
    // Spec §3.1 template, cheapest first, one line per retailer.
    expect(decoded).toContain("Apple iPhone 15, 128GB — Kuwait price check");
    expect(decoded).toContain("1. Xcite KD 204.90");
    expect(decoded).toContain("2. Yousifi KD 204.90");
    expect(decoded).toContain("3. Eureka KD 239.90");
    expect(decoded).toContain(`Live comparison: ${PDP_URL}`);
    // Cross-market Jarir and OOS Blink are excluded.
    expect(decoded).not.toContain("Jarir");
    expect(decoded).not.toContain("Blink");
    // The figures are the same formatter the card/PDP renders.
    expect(decoded).toContain(formatCountryPrice(204.9, "KWD", "KW").primary);
    expect(share.hasOffers).toBe(true);
    expect(share.href.length).toBeLessThan(WHATSAPP_SHARE_MAX_HREF);
  });

  it("keeps the link to origin + /product + the existing ?q= only, under 2,000 chars", () => {
    const share = buildWhatsAppShare({
      product: fixture(),
      query: QUERY,
      origin: ORIGIN,
      locale: "en",
      country: "KW",
    });
    expect(PDP_URL).toBe(`${ORIGIN}/product/apple-iphone15?q=iphone%2015`);
    expect(PDP_URL).not.toMatch(/market=|stock=|utm|session|token|ts=/);
    expect(share.href.length).toBeLessThan(WHATSAPP_SHARE_MAX_HREF);
  });

  it("quotes a non-KWD in-market source as ≈KD, never a bare native amount", () => {
    // Explicit Kuwait scope: a SAR offer is cross-market and excluded, so a
    // SAR-only product is the not-stocked case.
    const sarOnly = product([
      { merchant: "Jarir", price: 500, currency: "SAR", url: "https://jarir.example/p", inStock: true },
    ]);
    const kw = buildWhatsAppShare({
      product: sarOnly,
      query: QUERY,
      origin: ORIGIN,
      locale: "en",
      country: "KW",
    });
    expect(kw.hasOffers).toBe(false);
    expect(kw.message).toContain("not stocked in Kuwait right now");
    expect(kw.message).not.toContain("KD 0");

    // Under the Saudi selection the same row is in-market and keeps its own
    // rendered currency (the card's figure).
    const sa = buildWhatsAppShare({
      product: sarOnly,
      query: QUERY,
      origin: ORIGIN,
      locale: "en",
      country: "SA",
    });
    expect(sa.hasOffers).toBe(true);
    expect(sa.message.replace(/\u00A0/g, " ")).toContain("1. Jarir SAR 500.00");
  });

  it("caps the rendered title at 80 characters (77 + …)", () => {
    const long = "Sony WH-1000XM5 Wireless Noise Cancelling Headphones With A Very Long Retailer Title";
    expect(capShareTitle(long).length).toBeLessThanOrEqual(80);
    expect(capShareTitle(long).endsWith("…")).toBe(true);
  });
});

describe("REEA-1255 AC2 — zero-offer product page", () => {
  it("still builds a share and says not stocked, never KD 0", () => {
    const share = buildWhatsAppShare({
      product: product([]),
      query: QUERY,
      origin: ORIGIN,
      locale: "en",
      country: "KW",
    });
    expect(share.href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(share.message).toContain("Apple iPhone 15, 128GB — not stocked in Kuwait right now. Compare alternatives:");
    expect(share.message).toContain(PDP_URL);
    expect(share.message).not.toContain("KD 0");
    expect(share.hasOffers).toBe(false);
  });

  it("AR zero-offer message uses the Arabic template", () => {
    const share = buildWhatsAppShare({
      product: product([]),
      query: QUERY,
      origin: ORIGIN,
      locale: "ar",
      country: "KW",
    });
    expect(share.message).toContain("غير متوفر في الكويت حالياً. قارن البدائل:");
    expect(share.message).toContain(PDP_URL);
    expect(share.message).not.toContain("KD 0");
  });
});

describe("REEA-1255 AC2 — AR bidi hardening", () => {
  it("wraps the Latin title and every retailer/price token in LRI/PDI", () => {
    const share = buildWhatsAppShare({
      product: fixture(),
      query: QUERY,
      origin: ORIGIN,
      locale: "ar",
      country: "KW",
    });
    // Product title isolated, offer tokens isolated (spec §3.2 rule 7).
    expect(share.message).toContain("\u2066Apple iPhone 15, 128GB\u2069");
    expect(share.message).toContain("\u2066Xcite KD 204.90\u2069");
    expect(share.message).toContain("\u2066Yousifi KD 204.90\u2069");
    expect(share.message).toContain("\u2066Eureka KD 239.90\u2069");
    expect(share.message).toContain("مقارنة أسعار في الكويت");
    expect(share.message).toContain("المقارنة المباشرة:");
  });
});

describe("REEA-1255 AC2 — cheapest-first ordering and retailer dedupe", () => {
  it("sorts by converted KD and keeps one (cheapest) line per retailer", () => {
    const p = product([
      { merchant: "Eureka", price: 50, currency: "KWD", url: "https://eureka.example/p", inStock: true },
      { merchant: "Xcite", price: 40, currency: "KWD", url: "https://xcite.example/p", inStock: true },
      { merchant: "Xcite", price: 45, currency: "KWD", url: "https://xcite.example/p2", inStock: true },
      { merchant: "Jarir", price: 500, currency: "SAR", url: "https://jarir.example/p", inStock: true },
    ]);
    const share = buildWhatsAppShare({
      product: p,
      query: QUERY,
      origin: ORIGIN,
      locale: "en",
      country: "KW",
    });
    expect(share.message).toContain("1. Xcite KD 40");
    expect(share.message).toContain("2. Eureka KD 50");
    expect(share.message).not.toContain("KD 45");
  });
});
