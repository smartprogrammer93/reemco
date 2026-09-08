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
import { canonicalKey } from "@/lib/collect/canonical-product";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

const A4_TITLES = [
  "ASUS XA14 ROG STRIX SCOPE II X Wired Gaming Keyboard - Black",
  "Asus ROG Strix Scope II X RGB Wired Gaming Mechanical Keyboard - Black",
  "ASUS ROG STRIX SCOPE II X Wired Gaming Keyboard - Black",
  "Asus ROG Strix Scope II RX Wired RGB Optical Gaming Keyboard (ROG RX Red Switch) (Arabic Layout) - Black",
];

/** The one identity tuple A4 demands: brand | model line | colour | grade
 *  (empty storage filtered by the join rule), rendered space-separated as
 *  the spec writes it. */
const SCOPE_II_X = "asus rog strix scope ii x black";

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
