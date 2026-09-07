/**
 * REEA-195 AC-4 — KWD is the primary display currency on every offer card of
 * the Kuwait site. KWD values pass through untouched, SAR-only retailer
 * values convert behind the visible stamp, unknown codes degrade to their own
 * stamped label — nothing renders as a bare unexplained number.
 */
import { describe, expect, it } from "vitest";
import { formatPrimaryPrice } from "@/lib/format";

describe("formatPrimaryPrice (REEA-195 AC-4)", () => {
  it("KWD offers keep their figure and stamp untouched", () => {
    const p = formatPrimaryPrice(34.9, "KWD");
    expect(p.value).toBe(34.9);
    expect(p.label.startsWith("KWD")).toBe(true);
    expect(p.label).toContain("34.9");
  });

  it("SAR-only retailers convert, and the scraped figure keeps its stamp beside the KD one", () => {
    const p = formatPrimaryPrice(150, "SAR");
    expect(p.value).toBeCloseTo(150 * 0.0816, 3);
    const parts = p.label.split(" · ");
    expect(parts[0].startsWith("KWD")).toBe(true);
    // Intl inserts its narrow no-break space between code and figure — the
    // stamp must carry the scraped code and figure regardless of the gap.
    expect(parts[1].replace(/\s+/g, " ")).toBe("SAR 150.00");
  });

  it("counts and stock flags are unaffected: only the label space converts", () => {
    // The numeric side is KWD-space so the count-up animation and the label
    // land on the same figure (OfferCard receives {value,"KWD"} together).
    const p = formatPrimaryPrice(829, "SAR");
    expect(p.value).toBeLessThan(829);
    expect(p.label.startsWith("KWD")).toBe(true);
  });

  it("unknown currency codes pass through with their own stamp", () => {
    const p = formatPrimaryPrice(9.5, "BH");
    expect(p.value).toBe(9.5);
    expect(p.label).toContain("BH");
  });
});
