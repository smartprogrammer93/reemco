/**
 * REEA-310 — merge-gate spec (REA-307 revision): one keyboard
 * ("ASUS ROG Strix Scope II X") arrives from four retailers in four
 * differently decorated titles and must land on ONE card carrying all four
 * offers. The tests pin the pipeline additions: parenthesized annotations
 * drop with contents, descriptor noise extends, retailer shelf codes after
 * the brand drop, and a switch suffix after a numeral collapses onto it.
 *
 * Live-data fidelity: every title below is a live retailer spelling; the
 * merge is query-time aggregation over fetched titles only — no alias
 * table, no precomputed merged-product row.
 */
import { describe, expect, it } from "vitest";
import { canonicalKey, canonicalFields, compatibleFields, listingLabel } from "@/lib/collect/canonical-product";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

const A4_TITLES = [
  "ASUS XA14 ROG STRIX SCOPE II X Wired Gaming Keyboard - Black",
  "Asus ROG Strix Scope II X RGB Wired Gaming Mechanical Keyboard - Black",
  "ASUS ROG STRIX SCOPE II X Wired Gaming Keyboard - Black",
  "Asus ROG Strix Scope II RX Wired RGB Optical Gaming Keyboard (ROG RX Red Switch) (Arabic Layout) - Black",
];

/** The one identity tuple A4 demands: brand | model line | colour | grade
 *  (empty storage filtered by the join rule), rendered space-separated as
 *  the spec writes it. The "ROG" marker is a brand restatement (the sub-brand
 *  of ASUS the brand field already carries) and rides off with it. */
const SCOPE_II_X = "asus strix scope ii x black";

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "ASUS ROG Strix Scope II X Wired Gaming Keyboard - Black",
    merchant: "Blink",
    price: 37.5,
    currency: "KWD",
    url: "https://blink.example/p",
    inStock: true,
    country: "KW",
    ...over,
  };
}

describe("REEA-310 merge gate — A4: four retailer spellings, one key", () => {
  it("canonicalKey of every A4 title equals the one identity tuple", () => {
    for (const title of A4_TITLES) {
      expect(canonicalKey(title).replace(/\|/g, " ")).toBe(SCOPE_II_X);
    }
  });

  it("all four keys are identical, so one card carries all four offers", () => {
    const keys = A4_TITLES.map((title) => canonicalKey(title));
    expect(new Set(keys).size).toBe(1);
  });

  it("groupHits folds the four live offers into one ascending card", () => {
    // Four live retailer listings of the same device (REA-307 §A1-A3 shape):
    // one card, every retailer's offer carried, cheapest leading, ties kept
    // in stable fetch order (Xcite fetched before Quadra stays ahead at the
    // same figure). Same-retailer rows still fold to that retailer's best
    // listing — the REEA-192 contract, unchanged here.
    const offers: SearchHit[] = [
      hit({ title: A4_TITLES[0], merchant: "Blink", price: 37.5 }),
      hit({ title: A4_TITLES[1], merchant: "Xcite", price: 37.9 }),
      hit({ title: A4_TITLES[3], merchant: "Quadra", price: 37.9 }),
      hit({ title: A4_TITLES[2], merchant: "Jarir", price: 39.5 }),
    ];
    const products = groupHits("ASUS ROG Strix Scope II X", offers);
    expect(products).toHaveLength(1);
    expect(products[0].offers.map((o) => `${o.merchant}:${o.price}`)).toEqual([
      "Blink:37.5",
      "Xcite:37.9",
      "Quadra:37.9",
      "Jarir:39.5",
    ]);
  });
});

describe("REEA-310 merge gate — A5 guardrail: adjacent lines stay separate", () => {
  it("Scope II 96 Wireless differs from Scope II X and keeps its own key", () => {
    const wide = canonicalKey("ASUS ROG Strix Scope II 96 Wireless Keyboard");
    const narrow = canonicalKey(A4_TITLES[2]);
    expect(wide).not.toBe(narrow);
    // `ii` and `96` survive the shelf-code rule: only letter+digit prefixes
    // right after the brand ("xa14") are restatements.
    expect(wide).toContain("ii");
    expect(wide).not.toContain("xa14");
  });

  it("colours are not noise: black vs white stay separate cards", () => {
    expect(canonicalKey("ASUS ROG Strix Scope II X Wired Gaming Keyboard - Black")).not.toBe(
      canonicalKey("ASUS ROG Strix Scope II X Wired Gaming Keyboard - White"),
    );
  });
});

describe("REE-280 residual merge classes (live QA repros)", () => {
  // Every title below is captured verbatim from the deployed results surface
  // (ar-KW, q=Bose QuietComfort II / q=Samsung Crystal UHD 55). Each group is
  // one SKU whose retailer spellings diverge in listing chrome, not identity.
  it("Bose QC II: descriptor-tailed and short spellings of one SKU share a tuple", () => {
    const short = canonicalFields("Bose QuietComfort II Wireless Earbuds Black");
    const verbose = canonicalFields(
      "Bose QuietComfort II Earbuds, Noise Cancelling Microphone, Bluetooth, USB (Charging), Built-in Microphone, Eclipse Grey",
    );
    const plum = canonicalFields("Bose QuietComfort II Wireless Earbuds Plum");
    // Chrome words (earbud-descriptor restatements) never ride the line, so
    // all three spellings reduce to the same brand|model-line tuple.
    expect(short.modelLine).toBe("quietcomfort ii");
    expect(verbose.modelLine).toBe(short.modelLine);
    expect(plum.modelLine).toBe(short.modelLine);
    // Official colour names close the colour field; they do not extend the
    // model line, so colours merge inside the card as swatches (REEA-254).
    expect(short.color).toBe("black");
    expect(verbose.color).toBe("grey");
    expect(plum.color).toBe("plum");
    // One merge gate, no colour split: the live spellings land on one card.
    expect(compatibleFields({ ...short, color: "" }, { ...verbose, color: "" })).toBe(true);
    expect(compatibleFields({ ...short, color: "" }, { ...plum, color: "" })).toBe(true);
  });

  it("Samsung TVs: the bare model-family code and the full shelf code are one identity", () => {
    const bare = canonicalFields("Samsung Crystal UHD U8000F 4K Smart TV (2025)");
    const full = canonicalFields('Samsung 75" Crystal UHD U8000F 4K Smart TV, UA75U8000FUXZN');
    expect(compatibleFields(bare, full)).toBe(true);
    // A different code stem is a different SKU — containment is per token.
    const other = canonicalFields('Samsung 55" FLAT UHD 4K Resolution UA55CU7000UXZN (2023)');
    expect(compatibleFields(bare, other)).toBe(false);
  });

  it("generation parts stay discriminators: Air 11-inch and Air 13-inch keep two cards", () => {
    const air11 = canonicalFields("Apple iPad Air 11 inch M4 2026 128GB 5G MH794AB/A Blue");
    const air13 = canonicalFields("Apple iPad Air 13 inch M4 128GB Wi-Fi MH5N4AB/A Grey");
    expect(compatibleFields(air11, air13)).toBe(false);
  });

  it("groupHits folds the QC II live spellings into one card with merged offers", () => {
    const products = groupHits("bose quietcomfort ii", [
      hit({
        title: "Bose QuietComfort II Wireless Earbuds Black",
        merchant: "Xcite",
        price: 29.9,
        url: "https://xcite.example/qc2-black",
      }),
      hit({
        title: "Bose QuietComfort II Wireless Earbuds Plum",
        merchant: "Xcite",
        price: 31.9,
        url: "https://xcite.example/qc2-plum",
      }),
      hit({
        title:
          "Bose QuietComfort II Earbuds, Noise Cancelling Microphone, Bluetooth, USB (Charging), Built-in Microphone, Eclipse Grey",
        merchant: "Jarir",
        price: 480,
        currency: "SAR",
        url: "https://jarir.example/qc2-grey",
      }),
    ]);
    expect(products).toHaveLength(1);
    // Cheapest-first in KWD-space (SAR 480 ≈ KWD 39 behind KWD 29.9); same-
    // retailer rows still fold to that retailer's best listing (REEA-192),
    // so two Xcite listings keep the cheaper one.
    expect(products[0].offers.map((o) => `${o.merchant}:${o.price}`)).toEqual([
      "Xcite:29.9",
      "Jarir:480",
    ]);
    // The three spellings' colours ride the card as swatches (REEA-254).
    expect(products[0].variations.map((v) => v.label)).toEqual([
      "Black",
      "Plum",
      "Grey",
    ]);
  });
});

describe("REEA-310 merge gate — spec pipeline edges", () => {
  it("parenthesized annotations drop with contents; colour outside survives", () => {
    expect(
      canonicalKey("Asus ROG Strix Scope II RX Wired Gaming Keyboard (ROG RX Red Switch) (Arabic Layout) - Black"),
    ).toBe(canonicalKey("ASUS ROG STRIX SCOPE II X Wired Gaming Keyboard - Black"));
  });

  it("shelf code after the brand is a restatement, not a model line", () => {
    expect(canonicalKey("ASUS XA14 ROG STRIX SCOPE II X Wired Gaming Keyboard - Black")).toBe(
      canonicalKey("ASUS ROG STRIX SCOPE II X Wired Gaming Keyboard - Black"),
    );
  });
});

describe("REEA-486 merge gate — one card per model identity", () => {
  it("a region/version tail folds onto the short spelling of one line", () => {
    // "Japanese Version (eSIM)" restates the listing, not the SKU: both
    // spellings of the plain Pro must land on ONE key, and the two spellings
    // of the Pro Max on their own — the tail is chrome after the shared head.
    expect(canonicalKey("Apple iPhone 17 Pro - Japanese Version (eSIM)")).toBe(
      canonicalKey("Apple iPhone 17 Pro - eSIM"),
    );
    expect(canonicalKey("Apple iPhone 17 Pro Max - Japanese Version")).toBe(
      canonicalKey("Apple iPhone 17 Pro Max - eSIM"),
    );
  });

  it("the fold never blends model lines: Pro ≠ Pro Max ≠ case", () => {
    const pro = canonicalFields("Apple iPhone 17 Pro - eSIM");
    const max = canonicalFields("Apple iPhone 17 Pro Max - eSIM");
    const kase = canonicalFields("Apple iPhone 17 Pro Silicone Case");
    expect(compatibleFields(pro, max)).toBe(false);
    expect(compatibleFields(pro, kase)).toBe(false);
    expect(compatibleFields(max, kase)).toBe(false);
  });

  it("Arabic mirror: the qualifier folds in Arabic titles exactly as in Latin", () => {
    // Same structure for Arabic-script retailer titles (REEA-486 AC-5): the
    // version/region tail rides off, the line itself still discriminates.
    expect(canonicalKey("آيفون 17 برو - نسخة يابانية")).toBe(canonicalKey("آيفون 17 برو"));
    expect(
      compatibleFields(canonicalFields("آيفون 17 برو"), canonicalFields("آيفون 17 برو ماكس")),
    ).toBe(false);
  });

  it("listingLabel keeps the distinguishing qualifier and rides off restatements", () => {
    // The qualifier survives the merge …
    expect(
      listingLabel("Apple iPhone 17 Pro - Japanese Version (eSIM)", "Apple iPhone 17 Pro - eSIM"),
    ).toBe("Japanese Version");
    // … while words with their own slot on the card stay off the row: colour
    // swatches, capacities and grade badges keep single rows per merchant.
    expect(
      listingLabel("Apple iPhone 17 Pro Max 256GB Deep Blue", "Apple iPhone 17 Pro Max 256GB Silver"),
    ).toBe("");
    // Marketing tails ("with Face ID | Tax Paid …") are restatements, gone.
    expect(
      listingLabel(
        "Apple iPhone 17 Pro (256 GB) - Silver with Face ID | Tax Paid | 2 Years Official Warranty",
        'Apple iPhone 17 Pro 6.3" 256GB - Silver',
      ),
    ).toBe("");
  });

  it("REA-674: rebuilt labels are comma-clean, capped at 40 on a word boundary, entity-decoded", () => {
    // Axis fragments join on spaces — the raw comma never re-embeds.
    expect(listingLabel("Samsung Galaxy A16, Chip,48 Space, 5000mAh", "Samsung Galaxy A16")).toBe(
      "Chip 48 Space 5000mAh",
    );
    // Dangling punctuation trims off BOTH ends of a fragment.
    expect(listingLabel("Sony WH-1000XM6 Lavender,", "Sony WH-1000XM6")).toBe("Lavender");
    // Whole fragments past the budget drop from the tail; what survives ends
    // on a word boundary, never a mid-word cut.
    expect(
      listingLabel("Galaxy S25 FE, 6.7-inch, SM-S731BZKVMEA Navy,", "Samsung A57 5G"),
    ).toBe("Galaxy S25 FE 6.7-inch");
    // One oversized fragment snaps to its last word boundary inside the cap.
    // The card title shares no token, so the kept join is the whole
    // non-noise title — past the budget, exercising the snap.
    expect(
      listingLabel("Samsung Galaxy A07 MediaTek Helio G99 Dimensity Nitro Max", "Sony X"),
    ).toBe("Samsung Galaxy A07 MediaTek Helio G99");
    // Entities decode so the chip prints the figure, not the raw stamp.
    expect(listingLabel('Bundle Offer 6.9&quot; Compact', "Sony X")).toBe('Bundle Offer 6.9" Compact');
    // The Arabic path runs the identical pipeline.
    expect(listingLabel("كهربائي, خلاط", "خلاط")).toBe("كهربائي");
  });
});
