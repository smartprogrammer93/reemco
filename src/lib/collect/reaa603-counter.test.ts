/**
 * REEA-603 — coupon counter and visible chips agree (EN+AR).
 *
 * The deployed pair kept sampling two different fields: savings chips render
 * from the listing's live compare-at figures (wasPrice), while the embedded
 * summary counted only optional coupon text — so pages showing Save KD /
 * وفّر KD chips reported coupons:0 beside them. The fix is ONE delivered
 * signal (couponSignalOf) feeding both sides: the note counter and the card's
 * coupon slot. These tests pin the agreement: chips-visible ⇔ coupons >= 1,
 * explicit coupon text still wins the slot, plain offers keep an honest 0,
 * and every derived figure keeps the ≤2-decimal KD rule (REEA-574 R2) — the
 * same formatter renders EN and AR, so one decimal assertion covers both.
 *
 * Live-data fidelity: every fixture is the shape the live hops actually
 * answer with (compare-at above selling price, coupon text on the listing);
 * the derived label is formatted from those fetched fields only.
 */
import { describe, expect, it } from "vitest";
import { couponSignalOf, filterNotes, groupHits, type SearchHit } from "@/lib/collect/live-search";

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "Samsung Galaxy S25 5G 128GB Navy",
    merchant: "Xcite",
    price: 149.9,
    currency: "KWD",
    url: "https://www.xcite.com/samsung-galaxy-s25-128gb-navy/p",
    inStock: true,
    country: "KW",
    ...over,
  };
}

describe("REEA-603 couponSignalOf — one delivered-discount signal", () => {
  it("explicit coupon text wins the slot, code included, savings never double-counted", () => {
    const signal = couponSignalOf(
      hit({ coupon: { discount: "10% off", code: "SAVE10" }, wasPrice: 169 }),
    );
    expect(signal?.discount).toBe("10% off");
    expect(signal?.code).toBe("SAVE10");
  });

  it("falls back to the running discount the savings chip shows (compare-at above price)", () => {
    // Eureka-shape hop: clprc 149.9 under lprc 155.4 — the chip renders
    // "Save KD 5.50" beside the price; the signal says the same amount.
    const signal = couponSignalOf(hit({ price: 149.9, wasPrice: 155.4 }));
    expect(signal?.discount).toBe("KD 5.50");
    expect(signal?.code ?? null).toBeNull();
  });

  it("caps derived figures at two decimals — the fils tail is rounded, EN+AR share the formatter", () => {
    // 20.834 − 4.167 = 16.667 raw; the ≤2 rule prints "KD 16.67".
    const signal = couponSignalOf(hit({ price: 4.167, wasPrice: 20.834 }));
    expect(signal?.discount).toBe("KD 16.67");
    expect(signal?.discount).toMatch(/\d(\.\d{1,2})?$/);
  });

  it("no delivered discount → null: honest zero, never an invented signal", () => {
    expect(couponSignalOf(hit({}))).toBeNull(); // no coupon text, no compare-at
    expect(couponSignalOf(hit({ price: 100, wasPrice: 100 }))).toBeNull(); // equal figures
    expect(couponSignalOf(hit({ price: 100, wasPrice: 95 }))).toBeNull(); // compare-at below
  });
});

describe("REEA-603 embedded summary agrees with the rendered chips", () => {
  it("note coupon coverage counts savings-delivered hits (coupons >= 1 beside visible chips)", () => {
    const { notes } = filterNotes(null, [
      { merchant: "Xcite", hits: [hit({ wasPrice: 155.4 }), hit({})] },
    ]);
    // One savings offer + one plain offer → 1, with the honest hit total kept.
    expect(notes[0]?.coupons).toBe(1);
    expect(notes[0]?.hits).toBe(2);
  });

  it("a fully plain adapter keeps an honest coupons: 0", () => {
    const { notes } = filterNotes(null, [
      { merchant: "Blink", hits: [hit({ merchant: "Blink" })], error: undefined },
    ]);
    expect(notes[0]?.coupons).toBe(0);
  });

  it("groupHits carries the delivered signal into the card's coupons slot", () => {
    const products = groupHits("samsung galaxy s25", [hit({ wasPrice: 155.4 })]);
    expect(products).toHaveLength(1);
    expect(products[0]!.coupons.length).toBeGreaterThanOrEqual(1);
    expect(products[0]!.coupons[0]!.discount).toBe("KD 5.50");
    // Description mirrors the discount text — the badge and tooltip read one value.
    expect(products[0]!.coupons[0]!.description).toBe("KD 5.50");
  });

  it("plain offers still render the no-coupon state, not a padded count", () => {
    const products = groupHits("samsung galaxy s25", [hit({})]);
    expect(products[0]!.coupons).toEqual([]);
  });
});
