/**
 * REEA-195 AC-4 — KWD is the primary display currency on every offer card of
 * the Kuwait site. KWD values pass through untouched, SAR-only retailer
 * values convert behind the visible stamp, unknown codes degrade to their own
 * stamped label — nothing renders as a bare unexplained number.
 */
import { describe, expect, it } from "vitest";
import { formatCountryPrice, formatPrimaryPrice, sortOffers, toKwdNumeric } from "@/lib/format";

describe("formatPrimaryPrice (REEA-195 AC-4 / REEA-281 AC-2 / REEA-488 item 3)", () => {
  it("KWD offers render in the Kuwaiti KD convention — whole amounts bare, fils only when nonzero", () => {
    const p = formatPrimaryPrice(34.9, "KWD");
    expect(p.value).toBe(34.9);
    expect(p.label.startsWith("KD")).toBe(true);
    expect(p.label).toBe("KD 34.90");
    // REEA-488 AC: no trailing-zero noise on whole-number prices; a padded
    // hundredths figure keeps its second decimal.
    expect(formatPrimaryPrice(349, "KWD").label).toBe("KD 349");
    expect(formatPrimaryPrice(14.9, "KWD").label).toBe("KD 14.90");
    expect(formatPrimaryPrice(10, "KWD").label).toBe("KD 10");
    // REEA-281 AC-2's fils rule survives through REEA-488's "keep fils only
    // when nonzero": a nonzero third decimal is a measured figure.
    expect(formatPrimaryPrice(40.718, "KWD").label).toBe("KD 40.718");
  });

  it("SAR-only retailers convert ≈, and the scraped figure keeps its stamp beside the KD one", () => {
    const p = formatPrimaryPrice(150, "SAR");
    expect(p.value).toBeCloseTo(150 * 0.0816, 3);
    const parts = p.label.split(" · ");
    // REEA-281 AC-2: the converted side is a reference figure — marked ≈ and
    // rounded to ≤2 decimals — so it never reads as an exact scraped amount.
    expect(parts[0].startsWith("≈KD")).toBe(true);
    expect(parts[0]).toMatch(/\.\d{1,2}(?![\d])/);
    // Intl inserts its narrow no-break space between code and figure — the
    // stamp must carry the scraped code and figure regardless of the gap.
    expect(parts[1].replace(/\s+/g, " ")).toBe("SAR 150.00");
  });

  it("converted figures round to ≤2 decimals (499 SAR → ≈KD 40.72, not 40.718)", () => {
    // 499 × 0.0816 = 40.7184: the third decimal must not leak through the
    // reference conversion into the rendered label. Whole converted figures
    // follow the same no-trailing-zeros rule as native ones (REEA-488).
    expect(formatPrimaryPrice(499, "SAR").label.replace(/\s+/g, " ").startsWith("≈KD 40.72")).toBe(true);
    expect(formatPrimaryPrice(122.55, "SAR").label.replace(/\s+/g, " ").startsWith("≈KD 10")).toBe(true);
  });

  it("counts and stock flags are unaffected: only the label space converts", () => {
    // The numeric side is KWD-space so the count-up animation and the label
    // land on the same figure (OfferCard receives {value,"KWD"} together).
    const p = formatPrimaryPrice(829, "SAR");
    expect(p.value).toBeLessThan(829);
    expect(p.label.startsWith("≈KD")).toBe(true);
  });

  it("unknown currency codes pass through with their own stamp", () => {
    const p = formatPrimaryPrice(9.5, "BH");
    expect(p.value).toBe(9.5);
    expect(p.label).toContain("BH");
  });
});

describe("formatCountryPrice (REEA-283 country-led rows)", () => {
  const plain = (s: string) => s.replace(/\s+/g, " ");

  it("selected-country currency LEADS: c=SA puts the SAR figure first", () => {
    const p = formatCountryPrice(5199, "SAR", "SA");
    expect(p.value).toBe(5199);
    expect(plain(p.primary)).toBe("SAR 5,199.00");
    // The converted side rides behind as the muted stamp — REEA-281 rules.
    expect(p.alt?.startsWith("≈KD")).toBe(true);
    expect(p.alt).toMatch(/424\.24(?![\d])/);
  });

  it("c=KW over a SAR offer: KWD leads (≈ + ≤2 decimals), scraped SAR keeps its exact stamp", () => {
    const p = formatCountryPrice(499, "SAR", "KW");
    expect(p.primary.startsWith("≈KD")).toBe(true);
    expect(p.primary).toMatch(/40\.72(?![\d])/);
    expect(plain(p.alt ?? "")).toBe("SAR 499.00");
  });

  it("KWD-native offer under c=KW is ONE exact figure — fils kept, no stamp", () => {
    const p = formatCountryPrice(424.238, "KWD", "KW");
    expect(p.alt).toBeNull();
    expect(plain(p.primary)).toBe("KD 424.238");
  });

  it("c=SA over a KWD-native offer: SAR leads as ≈ figure, exact KWD stamp rides behind", () => {
    const p = formatCountryPrice(424.238, "KWD", "SA");
    expect(p.primary.startsWith("≈SAR")).toBe(true);
    expect(plain(p.alt ?? "")).toBe("KD 424.238");
  });

  it("EGP leads under c=EG; no selection keeps the offer-native figure first", () => {
    const eg = formatCountryPrice(1250, "EGP", "EG");
    expect(plain(eg.primary)).toBe("EGP 1,250.00");
    expect(eg.alt?.startsWith("≈KD")).toBe(true);

    const none = formatCountryPrice(150, "SAR", null);
    expect(plain(none.primary)).toBe("SAR 150.00");
    expect(none.alt?.startsWith("≈KD")).toBe(true);
    const kwdOnly = formatCountryPrice(34.9, "KWD", null);
    expect(kwdOnly.alt).toBeNull();
  });

  it("unknown offer codes pass through unconverted instead of inventing a bridge", () => {
    const p = formatCountryPrice(9.5, "BH", "SA");
    expect(p.alt).toBeNull();
    expect(p.primary).toContain("BH");
  });
});

describe("toKwdNumeric + sortOffers (REEA-254 item B)", () => {
  const offer = (price: number, currency: string, merchant = "m") => ({
    merchant,
    price,
    currency,
    url: `https://example/${merchant}`,
    inStock: true,
  });

  it("reference factors put every figure into KWD-space; unknown codes pass through", () => {
    expect(toKwdNumeric(419.9, "KWD")).toBe(419.9);
    expect(toKwdNumeric(5199, "SAR")).toBeCloseTo(424.238, 3);
    expect(toKwdNumeric(9.5, "BH")).toBe(9.5); // REEA-195 pass-through rule
  });

  it("cheapest-first compares on effective price, not raw numerics", () => {
    // SAR 5,199 (≈KD 424.24) is CHEAPER than KWD 429.9 — raw numerics would
    // order the KWD row first and the card header would show a non-cheapest
    // figure (the live QA case on the iPhone 17 Pro cards).
    const sorted = sortOffers([offer(429.9, "KWD", "xcite"), offer(5199, "SAR", "jarir")]);
    expect(sorted.map((o) => o.merchant)).toEqual(["jarir", "xcite"]);
  });
});
