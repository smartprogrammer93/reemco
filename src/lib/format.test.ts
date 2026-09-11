/**
 * REEA-195 AC-4 — KWD is the primary display currency on every offer card of
 * the Kuwait site. KWD values pass through untouched, SAR-only retailer
 * values convert behind the visible stamp, unknown codes degrade to their own
 * stamped label — nothing renders as a bare unexplained number.
 */
import { describe, expect, it } from "vitest";
import { effectivePriceKwd, formatCountryPrice, formatKWD, formatPrimaryPrice, sortOffers, toKwdNumeric } from "@/lib/format";

describe("formatKWD — the single KD formatter (REEA-574 R2)", () => {
  it("caps every figure at two decimals with Intl half-expand rounding", () => {
    // The spec examples, one value per render-shape: fraction rounds to two,
    // hundredths pads its trailing zero, whole amounts stay bare.
    expect(formatKWD(559.867)).toBe("559.87");
    expect(formatKWD(505.838)).toBe("505.84");
    expect(formatKWD(6.5)).toBe("6.50");
    expect(formatKWD(3)).toBe("3");
    // Grouping survives on the big figures.
    expect(formatKWD(4099)).toBe("4,099");
  });

  it("one helper prints chip and twin of the same value identically", () => {
    // The REEA-574 observed case: chip `KD 505.838` vs twin `≈KD 505.84`.
    // Both render paths now share formatKWD — the KD figure is the same string.
    const chip = formatPrimaryPrice(505.838, "KWD").label; // `KD 505.84`
    const twin = formatCountryPrice(505.838, "KWD", null).primary; // `KD 505.84`
    expect(chip).toBe("KD 505.84");
    expect(chip).toBe(twin);
  });
});

describe("formatPrimaryPrice (REEA-195 AC-4 / REEA-281 AC-2 / REEA-488 item 3)", () => {
  it("KWD offers render in the Kuwaiti KD convention — whole amounts bare, fractions capped at hundredths", () => {
    const p = formatPrimaryPrice(34.9, "KWD");
    expect(p.value).toBe(34.9);
    expect(p.label.startsWith("KD")).toBe(true);
    expect(p.label).toBe("KD 34.90");
    // REEA-488 AC: no trailing-zero noise on whole-number prices; a padded
    // hundredths figure keeps its second decimal.
    expect(formatPrimaryPrice(349, "KWD").label).toBe("KD 349");
    expect(formatPrimaryPrice(14.9, "KWD").label).toBe("KD 14.90");
    expect(formatPrimaryPrice(10, "KWD").label).toBe("KD 10");
    // REEA-574 R2: the ≤2 cap now covers the KWD-native side too — a third
    // decimal is rounded, never printed (REEA-281 was the derived side only).
    expect(formatPrimaryPrice(40.718, "KWD").label).toBe("KD 40.72");
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

  it("KWD-native offer under c=KW is ONE figure capped at hundredths — no stamp", () => {
    const p = formatCountryPrice(424.238, "KWD", "KW");
    expect(p.alt).toBeNull();
    expect(plain(p.primary)).toBe("KD 424.24");
  });

  it("c=SA over a KWD-native offer: SAR leads as ≈ figure, capped KWD stamp rides behind", () => {
    const p = formatCountryPrice(424.238, "KWD", "SA");
    expect(p.primary.startsWith("≈SAR")).toBe(true);
    expect(plain(p.alt ?? "")).toBe("KD 424.24");
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

describe("REEA-604 — normalized effective price drives cross-currency ordering", () => {
  const offer = (merchant: string, price: number, currency: string, extra?: { wasPrice?: number }) => ({
    merchant,
    price,
    currency,
    url: `https://example/${merchant}`,
    inStock: true,
    ...extra,
  });

  it("QA fixture: KWD/SAR/EGP offers order like the hand-computed reference (within 2%)", () => {
    // The live 'iphone 15' case from the issue: Blink KD 349 next to Jarir
    // SAR 79. Hand-computed through the REEA-195 reference table:
    //   SAR 79    × 0.0816 = KD 6.45   (Jarir, cheapest)
    //   EGP 1,250 × 0.0061 = KD 7.63   (Amazon.eg)
    //   KWD 349            = KD 349    (Blink)
    const offers = [offer("Blink", 349, "KWD"), offer("Jarir", 79, "SAR"), offer("Amazon.eg", 1250, "EGP")];
    const reference: Record<string, number> = { Jarir: 6.45, "Amazon.eg": 7.63, Blink: 349 };

    const sorted = sortOffers(offers);
    expect(sorted.map((o) => o.merchant)).toEqual(["Jarir", "Amazon.eg", "Blink"]);

    for (const o of sorted) {
      const eff = effectivePriceKwd(o.price, o.currency);
      const ref = reference[o.merchant];
      expect(Math.abs(eff - ref) / ref).toBeLessThanOrEqual(0.02);
    }
  });

  it("identical ordering across repeated loads, whatever the arrival order", () => {
    const base = [offer("Blink", 349, "KWD"), offer("Jarir", 79, "SAR"), offer("Amazon.eg", 1250, "EGP")];
    const shuffled = [offer("Amazon.eg", 1250, "EGP"), offer("Blink", 349, "KWD"), offer("Jarir", 79, "SAR")];
    const first = sortOffers(base).map((o) => o.merchant);
    expect(sortOffers(base).map((o) => o.merchant)).toEqual(first);
    expect(sortOffers(shuffled).map((o) => o.merchant)).toEqual(first);
  });

  it("coupon evidence folds into the ordering key", () => {
    // A $8-off card discount is worth more inside the KWD listing than inside
    // the SAR one (it is applied in each listing's native space, then
    // normalized): listed order [Jarir, Xcite] (KD 19.99 vs KD 20) flips to
    // [Xcite, Jarir] once the coupon is folded (KD 12 vs ≈KD 19.34). The fold
    // must also match the hand-computed figures, not just the permutation.
    const xcite = offer("xcite", 20, "KWD");
    const jarir = offer("jarir", 245, "SAR");
    expect(sortOffers([xcite, jarir]).map((o) => o.merchant)).toEqual(["jarir", "xcite"]);
    expect(sortOffers([xcite, jarir], { discount: "$8 off" }).map((o) => o.merchant)).toEqual([
      "xcite",
      "jarir",
    ]);
    expect(effectivePriceKwd(245, "SAR", { couponDiscount: "$8 off" })).toBeCloseTo(19.34, 2);
    expect(effectivePriceKwd(349, "KWD", { couponDiscount: "5% off" })).toBeCloseTo(331.55, 2);
  });

  it("a lower was-price is best-attested evidence and folds in", () => {
    // The retailer's own record shows KD 92 achievable under the KD 100
    // listing; that figure — not the listed one — competes with KD 95.
    const a = offer("a", 100, "KWD", { wasPrice: 92 });
    const b = offer("b", 95, "KWD");
    expect(sortOffers([a, b]).map((o) => o.merchant)).toEqual(["a", "b"]);
    expect(effectivePriceKwd(100, "KWD", { wasPrice: 92 })).toBeCloseTo(92, 6);
  });

  it("unknown codes pass through their own numerics — never an invented bridge", () => {
    expect(effectivePriceKwd(9.5, "BH")).toBe(9.5);
    expect(effectivePriceKwd(5199, "SAR")).toBeCloseTo(424.238, 3);
  });
});
