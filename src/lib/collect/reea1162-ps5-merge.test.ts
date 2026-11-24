/**
 * REEA-1162 — the PS5 DualSense shelf must merge ONE card per controller SKU.
 *
 * Live QA on `d9f31b54` (REEA-1118) measured two faces of one merge defect:
 *  1. the base "Sony PS5 DualSense Wireless Controller" card appeared in only
 *     3/6 collections; the others showed single-offer colour/edition cards;
 *  2. Alpine Green, Volcanic Red, Graphite Grey, Flare Orange and Techno Red
 *     stayed separate 1-offer cards beside a merged card that already exposed
 *     a "Green" swatch.
 *
 * Root cause: the platform token (`PS5` / `PlayStation 5`) is IDENTITY only
 * when it discriminates a SKU, but its POSITION is retailer chrome. The head
 * skip dropped a leading `ps5`; the same token mid-title ("Sony DualSense PS5
 * Controller …", "Sony PlayStation 5 DualSense …") stayed in the model line and
 * forked the controller. Unrecognised colour modifiers (volcanic / flare /
 * techno / emerald) forked it the same way.
 *
 * These pins are query-time aggregation over fetched titles only — no alias
 * table, no catalog rows. Colours ride inside the card as swatches; genuinely
 * different EDITIONS (Limited Edition, GTA VI, Wolverine, Gran Turismo) keep
 * their own cards, because their model line really differs.
 */
import { describe, expect, it } from "vitest";
import { canonicalFields, compatibleFields } from "@/lib/collect/canonical-product";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

function hit(title: string, merchant: string, price: number, url?: string): SearchHit {
  return {
    title,
    merchant,
    price,
    currency: "KWD",
    url: url ?? `https://retailer.example/${merchant}/${encodeURIComponent(title)}`,
    inStock: true,
    country: "KW",
  };
}

/** Every live spelling QA sampled for the same controller colourway, plus the
 *  base spelling the merged card is titled from when a retailer carries it. */
const SPELLINGS = [
  "Sony PS5 DualSense Wireless Controller",
  "Sony PS5 DualSense Wireless Controller Alpine Green",
  "Sony PlayStation 5 DualSense Wireless Controller Alpine Green",
  "Sony PlayStation 5 DualSense Wireless Controller PS5 Alpine Green",
  "Sony DualSense PS5 Controller Graphite Grey",
  "Sony DualSense PS5 Controller Graphite Grey (Pre-Order)",
  "Sony PS5 DualSense Wireless Controller - Volcanic Red",
  "Sony PS5 DualSense Wireless Controller - Techno Red",
  "Sony DualSense PS5 Controller Flare Orange",
  "Sony DualSense PS5 Controller Flare Orange (Pre-Order)",
  "Sony DualSense PS5 Controller Emerald (Pre-Order)",
  "Sony DualSense PS5 Controller Nova Pink",
];

describe("REEA-1162 — platform position is not identity", () => {
  it("folds PS5 / PlayStation 5 out of the model line wherever it appears", () => {
    for (const title of SPELLINGS) {
      const f = canonicalFields(title);
      expect(f.modelLine).toBe("dualsense controller");
      expect(f.platform).toBe("ps5");
    }
  });

  it("keeps a real platform split apart (PS5 game ≠ PS4 game)", () => {
    const ps5 = canonicalFields("EA Sports FC 27 PS5");
    const ps4 = canonicalFields("EA Sports FC 27 PS4");
    expect(ps5.platform).toBe("ps5");
    expect(ps4.platform).toBe("ps4");
    expect(compatibleFields(ps5, ps4)).toBe(false);
    // A spelling that omits the platform still joins through partial-match.
    expect(compatibleFields(ps5, canonicalFields("EA Sports FC 27"))).toBe(true);
  });

  it("folds the reported colour modifiers into the colour slot", () => {
    expect(canonicalFields("Sony PS5 DualSense Wireless Controller - Volcanic Red").color).toBe("red");
    expect(canonicalFields("Sony PS5 DualSense Wireless Controller - Techno Red").color).toBe("red");
    expect(canonicalFields("Sony DualSense PS5 Controller Flare Orange").color).toBe("orange");
    expect(canonicalFields("Sony DualSense PS5 Controller Emerald").color).toBe("emerald");
    expect(canonicalFields("Sony DualSense PS5 Controller Graphite Grey").color).toBe("grey");
  });
});

describe("REEA-1162 — one DualSense card, colourways as swatches", () => {
  it("merges every live spelling into ONE card titled by the base spelling", () => {
    const products = groupHits(
      "ps5",
      SPELLINGS.map((title, i) => hit(title, i % 2 === 0 ? "Eureka" : "Astore", 28.9 + i)),
    );
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe("Sony PS5 DualSense Wireless Controller");
    // Every retailer that answered is represented on the ONE card (the card
    // itself folds same-merchant rows per REEA-192/486; colourways ride the
    // swatch chips instead of forking cards).
    expect([...new Set(products[0].offers.map((o) => o.merchant))].sort()).toEqual([
      "Astore",
      "Eureka",
    ]);
    expect((products[0].variations ?? []).map((v) => v.label)).toEqual(
      expect.arrayContaining(["Green", "Grey", "Red", "Orange", "Emerald", "Pink"]),
    );
  });

  it("merges a colourway-only collection onto the SAME slug as the base card", () => {
    const baseOnly = groupHits("ps5", [
      hit("Sony PS5 DualSense Wireless Controller", "Wibi", 20.9),
      hit("Sony DualSense PS5 Controller Graphite Grey", "Astore", 28.9),
    ]);
    const colourOnly = groupHits("ps5", [
      hit("Sony DualSense PS5 Controller Graphite Grey", "Astore", 28.9),
      hit("Sony PlayStation 5 DualSense Wireless Controller Alpine Green", "Eureka", 30.25),
    ]);
    expect(baseOnly).toHaveLength(1);
    expect(colourOnly).toHaveLength(1);
    // The slug is the merge identity, not whichever spelling arrived first.
    expect(baseOnly[0].productId).toBe("sony-dualsense-controller-ps5");
    expect(colourOnly[0].productId).toBe("sony-dualsense-controller-ps5");
  });

  it("keeps a genuinely different EDITION on its own card", () => {
    const products = groupHits("ps5", [
      hit("Sony PS5 DualSense Wireless Controller", "Wibi", 20.9),
      hit("Sony DualSense PS5 Controller Lisa Limited Edition", "Eureka", 30.5),
      hit("Sony DualSense PS5 Controller GTA VI Black", "Eureka", 30.5),
      hit("Sony DualSense PS5 Controller Marvels Wolverine", "Eureka", 30.5),
      hit("Sony PS5 DualSense Edge Wireless Controller - White", "Eureka", 34.9),
    ]);
    // Base + the four distinct editions, each once.
    expect(products).toHaveLength(5);
    expect(new Set(products.map((p) => p.productId)).size).toBe(5);
  });
});
