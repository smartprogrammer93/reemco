/**
 * REEA-1207 AC 7B-1 — cross-retailer model identity.
 *
 * Live evidence on the served shelf: the same model listed by two retailers
 * never merged, so the shelf painted two single-retailer cards instead of one
 * comparison. "Sony WH-1000XM5 Wireless Industry Leading Noise Canceling …"
 * (Blink) and "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black"
 * (Xcite) produced different model lines, and so did the two WH-CH720N
 * spellings. These tests pin the identity that makes them one card.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { canonicalFields, compatibleFields } from "@/lib/collect/canonical-product";
import { groupHits } from "@/lib/collect/live-search";

const hit = (o: {
  title: string;
  merchant: string;
  price: number;
  url: string;
}) => ({
  title: o.title,
  merchant: o.merchant,
  price: o.price,
  currency: "KWD",
  url: o.url,
  inStock: true,
  country: "KW" as const,
  scrapedAt: "2026-11-26T00:00:00.000Z",
});

describe("REEA-1207 — the same model at two retailers is one identity", () => {
  it("folds a model code followed by listing prose onto the code", () => {
    const prose = canonicalFields(
      "Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones with Auto Noise Canceling Optimizer, Crystal Clear Hands-Free Calling, and Alexa Voice Control - Midnight Blue",
    );
    const plain = canonicalFields("Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black");
    expect(prose.modelLine).toBe("wh1000xm5");
    expect(plain.modelLine).toBe("wh1000xm5");
    // Colour is a variation, not an identity: the family fold puts the two
    // retailers on one card (pinned by the groupHits case below).
  });

  it("reconciles the hyphen-split shelf code with the unbroken spelling", () => {
    const a = canonicalFields(
      "Sony WH-CH720N Over-Ear Headphones, Noise Cancelling, Bluetooth/Wired (Optional), USB (Charging), Built-in Microphone, Black",
    );
    const b = canonicalFields(
      "Sony WH-CH720N Noise Canceling Wireless Headphones Bluetooth with Microphone & Alexa Built-in",
    );
    expect(a.modelLine).toBe("whch720n");
    expect(b.modelLine).toBe("whch720n");
    expect(compatibleFields(a, b)).toBe(true);
  });

  it("keeps genuinely different model lines apart", () => {
    const pro = canonicalFields("Apple iPhone 17 Pro 256GB");
    const proMax = canonicalFields("Apple iPhone 17 Pro Max 256GB");
    expect(pro.modelLine).not.toBe(proMax.modelLine);
    expect(compatibleFields(pro, proMax)).toBe(false);

    const xm6 = canonicalFields("Sony WH-1000XM6 Wireless Headphones");
    const ch720 = canonicalFields("Sony WH-CH720N Wireless Headphones");
    expect(compatibleFields(xm6, ch720)).toBe(false);
  });

  it("folds a console class word onto the same shelf item", () => {
    // Live: "Nintendo Switch 2 Console - Black" (Blink) and "Nintendo
    // Switch 2" (Eureka) are the same console at two retailers.
    const a = canonicalFields("Nintendo Switch 2 Console - Black");
    const b = canonicalFields("Nintendo Switch 2");
    expect(compatibleFields(a, b)).toBe(true);
  });

  it("folds pharmacy pack descriptors onto one identity", () => {
    // Live: the same 24-tablet pack at Danube Home and BinSina.
    const danube = canonicalFields("Panadol Extra Pain Relief Tablets 24tablets");
    const binsina = canonicalFields("Panadol Extra Optizorb Tablets 24's");
    expect(compatibleFields(danube, binsina)).toBe(true);
    // A different formulation stays a different product.
    const sinus = canonicalFields("Panadol Sinus Caplets 24's");
    const coldFlu = canonicalFields("Panadol Cold+Flu Day Caplets 24's");
    expect(compatibleFields(sinus, coldFlu)).toBe(false);
  });

  it("still separates an accessory from the device it fits", () => {
    const phone = canonicalFields("Apple iPhone 17 Pro 256GB");
    const kase = canonicalFields("Apple iPhone 17 Pro Silicone Case");
    expect(compatibleFields(phone, kase)).toBe(false);
  });

  it("paints one comparison card for the two retailer listings", () => {
    const products = groupHits("sony wh-1000xm5", [
      hit({
        title:
          "Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones with Auto Noise Canceling Optimizer, Crystal Clear Hands-Free Calling, and Alexa Voice Control - Midnight Blue",
        merchant: "Blink",
        price: 89.9,
        url: "https://blink.example/xm5-blue",
      }),
      hit({
        title: "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black",
        merchant: "Xcite",
        price: 94.9,
        url: "https://xcite.example/xm5-black",
      }),
    ]);
    expect(products).toHaveLength(1);
    expect(new Set(products[0].offers.map((o) => o.merchant))).toEqual(
      new Set(["Blink", "Xcite"]),
    );
  });
});
