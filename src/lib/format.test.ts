/**
 * REEA-195 AC-4 — KWD is the primary display currency on every offer card of
 * the Kuwait site. KWD values pass through untouched, SAR-only retailer
 * values convert behind the visible stamp, unknown codes degrade to their own
 * stamped label — nothing renders as a bare unexplained number.
 */
import { describe, expect, it } from "vitest";
import { formatCountryPrice, formatPrimaryPrice } from "@/lib/format";

describe("formatPrimaryPrice (REEA-195 AC-4 / REEA-281 AC-2)", () => {
  it("KWD offers keep their figure and stamp untouched — full fils precision", () => {
    const p = formatPrimaryPrice(34.9, "KWD");
    expect(p.value).toBe(34.9);
    expect(p.label.startsWith("KWD")).toBe(true);
    expect(p.label).toContain("34.9");
    // REEA-281 AC-2 scopes the rounding rule to CONVERTED figures: a
    // KWD-native amount keeps its exact fils precision, no ≈ prefix.
    expect(formatPrimaryPrice(40.718, "KWD").label).toContain("40.718");
  });

  it("SAR-only retailers convert ≈, and the scraped figure keeps its stamp beside the KD one", () => {
    const p = formatPrimaryPrice(150, "SAR");
    expect(p.value).toBeCloseTo(150 * 0.0816, 3);
    const parts = p.label.split(" · ");
    // REEA-281 AC-2: the converted side is a reference figure — marked ≈ and
    // rounded to ≤2 decimals — so it never reads as an exact scraped amount.
    expect(parts[0].startsWith("≈KWD")).toBe(true);
    expect(parts[0]).toMatch(/\.\d{1,2}(?![\d])/);
    // Intl inserts its narrow no-break space between code and figure — the
    // stamp must carry the scraped code and figure regardless of the gap.
    expect(parts[1].replace(/\s+/g, " ")).toBe("SAR 150.00");
  });

  it("converted figures round to ≤2 decimals (499 SAR → ≈KWD 40.72, not 40.718)", () => {
    // 499 × 0.0816 = 40.7184: the third decimal must not leak through the
    // reference conversion into the rendered label.
    expect(formatPrimaryPrice(499, "SAR").label.replace(/\s+/g, " ").startsWith("≈KWD 40.72")).toBe(true);
  });

  it("counts and stock flags are unaffected: only the label space converts", () => {
    // The numeric side is KWD-space so the count-up animation and the label
    // land on the same figure (OfferCard receives {value,"KWD"} together).
    const p = formatPrimaryPrice(829, "SAR");
    expect(p.value).toBeLessThan(829);
    expect(p.label.startsWith("≈KWD")).toBe(true);
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
    expect(p.alt?.startsWith("≈KWD")).toBe(true);
    expect(p.alt).toMatch(/424\.24(?![\d])/);
  });

  it("c=KW over a SAR offer: KWD leads (≈ + ≤2 decimals), scraped SAR keeps its exact stamp", () => {
    const p = formatCountryPrice(499, "SAR", "KW");
    expect(p.primary.startsWith("≈KWD")).toBe(true);
    expect(p.primary).toMatch(/40\.72(?![\d])/);
    expect(plain(p.alt ?? "")).toBe("SAR 499.00");
  });

  it("KWD-native offer under c=KW is ONE exact figure — fils kept, no stamp", () => {
    const p = formatCountryPrice(424.238, "KWD", "KW");
    expect(p.alt).toBeNull();
    expect(plain(p.primary)).toBe("KWD 424.238");
  });

  it("c=SA over a KWD-native offer: SAR leads as ≈ figure, exact KWD stamp rides behind", () => {
    const p = formatCountryPrice(424.238, "KWD", "SA");
    expect(p.primary.startsWith("≈SAR")).toBe(true);
    expect(plain(p.alt ?? "")).toBe("KWD 424.238");
  });

  it("EGP leads under c=EG; no selection keeps the offer-native figure first", () => {
    const eg = formatCountryPrice(1250, "EGP", "EG");
    expect(plain(eg.primary)).toBe("EGP 1,250.00");
    expect(eg.alt?.startsWith("≈KWD")).toBe(true);

    const none = formatCountryPrice(150, "SAR", null);
    expect(plain(none.primary)).toBe("SAR 150.00");
    expect(none.alt?.startsWith("≈KWD")).toBe(true);
    const kwdOnly = formatCountryPrice(34.9, "KWD", null);
    expect(kwdOnly.alt).toBeNull();
  });

  it("unknown offer codes pass through unconverted instead of inventing a bridge", () => {
    const p = formatCountryPrice(9.5, "BH", "SA");
    expect(p.alt).toBeNull();
    expect(p.primary).toContain("BH");
  });
});
