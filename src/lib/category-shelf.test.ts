/**
 * REEA-1268 — the pure projection behind a live `/c/<slug>` shelf.
 *
 * These pins protect the honesty contract the ticket's D-1/D-3/D-4 name:
 *  - only category members reach the shelf (a supplementary term cannot pad
 *    it with an unrelated product);
 *  - one card per productId, with the richer live offer set winning;
 *  - notes merge per merchant (a store counts once), and a merchant that
 *    answered any term is never named failed for a sibling term;
 *  - a run that could not answer (or finalized at its budget) is marked
 *    partial, so the page never reads an incomplete fan-out as a settled
 *    honest zero.
 */
import { describe, expect, it } from "vitest";
import { mergeCategoryNotes, mergeCategoryStage } from "@/lib/category-shelf";
import { categoryBySlug } from "@/lib/categories";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

const STAMP = "2026-11-27T20:00:00.000Z";
const STAMP_MS = Date.parse(STAMP);
const LATER = "2026-11-27T20:05:00.000Z";
const LATER_MS = Date.parse(LATER);

function offer(merchant: string, price: number): PriceOffer {
  return {
    merchant,
    price,
    currency: "KWD",
    url: `https://example.test/${merchant}/${price}`,
    inStock: true,
    collectedAt: STAMP,
    collectedAtEpochMs: STAMP_MS,
  };
}

function product(
  productId: string,
  title: string,
  offers: PriceOffer[],
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "Brand",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: STAMP,
    scrapedAtEpochMs: STAMP_MS,
    productScope: "primary",
  };
}

function snap(
  products: NormalizedProduct[],
  notes: LiveSearchResult["notes"],
  over: Partial<LiveSearchResult> = {},
): LiveSearchResult {
  return {
    products,
    notes,
    collectedAt: STAMP,
    collectedAtEpochMs: STAMP_MS,
    settled: true,
    ...over,
  };
}

describe("mergeCategoryStage (REEA-1268 D-1/D-3)", () => {
  it("merges live terms, drops off-category products and de-duplicates cards", () => {
    const def = categoryBySlug("air-fryers")!;
    const philipsA = product("philips-air-fryer-1700w", "Philips Air Fryer 1700W 6.2L", [
      offer("Xcite", 45),
      offer("Eureka", 47),
    ]);
    const xiaomi = product("xiaomi-air-fryer-6-5l", "Xiaomi Air Fryer 6.5L", [
      offer("Eureka", 23),
    ]);
    const blender = product("philips-blender-800w", "Philips Blender 800W", [
      offer("Xcite", 19),
    ]);
    const philipsB = product("philips-air-fryer-1700w", "Philips Air Fryer 1700W 6.2L", [
      offer("Xcite", 44),
      offer("Eureka", 46),
      offer("Wibi", 43),
    ]);
    const ninja = product("ninja-max-pro-air-fryer", "Ninja Max Pro Air Fryer 6.2L", [
      offer("Wibi", 59),
    ]);
    const stage = mergeCategoryStage(
      [
        {
          term: "air fryer",
          snap: snap([philipsA, xiaomi, blender], [
            { merchant: "Xcite", hits: 2 },
            { merchant: "Jarir", hits: 0, error: "no answer within the budget" },
          ]),
        },
        {
          term: "ninja air fryer",
          snap: snap([philipsB, ninja], [
            { merchant: "Xcite", hits: 1 },
            { merchant: "Wibi", hits: 1 },
          ], { collectedAt: LATER, collectedAtEpochMs: LATER_MS }),
        },
      ],
      def,
      null,
      false,
      2,
    );

    // The blender matched the "air fryer" term's shelf but not the category.
    // Order follows the renderer's own price-ranked primary shelf, and the
    // duplicate Philips card keeps its slot with the richer offer set.
    expect(stage.cards.map((p) => p.productId)).toEqual([
      "xiaomi-air-fryer-6-5l",
      "philips-air-fryer-1700w",
      "ninja-max-pro-air-fryer",
    ]);
    // One card per product, and the richer live offer set won.
    const philips = stage.cards.find((p) => p.productId === "philips-air-fryer-1700w")!;
    expect(philips.offers).toHaveLength(3);
    expect(stage.settled).toBe(true);
    expect(stage.partial).toBe(false);
    expect(stage.answeredTerms).toBe(2);
    // Newest live stamp wins so the provenance line names the freshest run.
    expect(stage.collectedAtEpochMs).toBe(LATER_MS);
    // One note per merchant; Xcite answered (hits > 0), so its sibling-term
    // error is cleared rather than naming the store failed.
    const notes = stage.notes;
    expect(notes.filter((n) => n.merchant === "Xcite")).toHaveLength(1);
    expect(notes.find((n) => n.merchant === "Xcite")?.hits).toBe(3);
    expect(notes.find((n) => n.merchant === "Xcite")?.error).toBeUndefined();
    expect(notes.find((n) => n.merchant === "Jarir")?.error).toBeDefined();
    expect(notes.filter((n) => n.merchant === "Wibi")).toHaveLength(1);
  });

  it("keeps a dishwasher off the washing-machines shelf", () => {
    const def = categoryBySlug("washing-machines")!;
    const washer = product("lg-washing-machine-9kg", "LG Washing Machine 9kg", [
      offer("Xcite", 199),
    ]);
    const dishwasher = product("bosch-dishwasher-12p", "Bosch Dishwasher 12 Place", [
      offer("Xcite", 149),
    ]);
    const stage = mergeCategoryStage(
      [{ term: "washer", snap: snap([washer, dishwasher], [{ merchant: "Xcite", hits: 2 }]) }],
      def,
      null,
      false,
      1,
    );
    expect(stage.cards.map((p) => p.productId)).toEqual(["lg-washing-machine-9kg"]);
  });

  it("accepts the pharmacy terms' own scoped shelf", () => {
    const def = categoryBySlug("pharmacy")!;
    const panadol = product("panadol-extra-24", "Panadol Extra 24 Tablets", [
      offer("Nahdi", 1.5),
    ]);
    const vitamin = product("vitamin-d-1000", "Vitamin D3 1000 IU", [offer("BinSina", 3)]);
    const stage = mergeCategoryStage(
      [
        {
          term: "pharmacy",
          snap: snap([panadol], [{ merchant: "Nahdi", hits: 1 }]),
        },
        {
          term: "medicine",
          snap: snap([vitamin], [{ merchant: "BinSina", hits: 1 }]),
        },
      ],
      def,
      null,
      false,
      2,
    );
    expect(stage.cards.map((p) => p.productId)).toEqual([
      "panadol-extra-24",
      "vitamin-d-1000",
    ]);
  });

  it("marks a run that could not answer as partial, never as an honest zero", () => {
    const def = categoryBySlug("tv")!;
    const stage = mergeCategoryStage(
      [
        { term: "television", snap: null },
        { term: "tv", snap: null },
      ],
      def,
      null,
      false,
      2,
    );
    expect(stage.cards).toEqual([]);
    expect(stage.settled).toBe(false);
    expect(stage.partial).toBe(true);
    expect(stage.answeredTerms).toBe(0);
    expect(stage.totalTerms).toBe(2);
  });

  it("marks a finalized-at-budget run as partial", () => {
    const def = categoryBySlug("laptops")!;
    const stage = mergeCategoryStage(
      [
        {
          term: "laptop",
          snap: snap(
            [product("asus-vivobook-15", "ASUS VivoBook 15 Laptop", [offer("Xcite", 210)])],
            [{ merchant: "Xcite", hits: 1 }],
            { settled: false },
          ),
        },
      ],
      def,
      null,
      false,
      1,
    );
    expect(stage.cards).toHaveLength(1);
    expect(stage.settled).toBe(false);
    expect(stage.partial).toBe(true);
  });
});

describe("mergeCategoryNotes", () => {
  it("counts a store once across terms and clears a sibling-term error when it answered", () => {
    const notes = mergeCategoryNotes([
      {
        term: "a",
        snap: snap([], [{ merchant: "Xcite", hits: 2, coupons: 1 }]),
      },
      {
        term: "b",
        snap: snap([], [{ merchant: "Xcite", hits: 1, error: "timeout" }]),
      },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ merchant: "Xcite", hits: 3 });
    expect(notes[0].error).toBeUndefined();
  });

  it("keeps an error when the store answered no term", () => {
    const notes = mergeCategoryNotes([
      { term: "a", snap: snap([], [{ merchant: "Jarir", hits: 0, error: "blocked:403" }]) },
      { term: "b", snap: null },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ merchant: "Jarir", hits: 0, error: "blocked:403" });
  });
});
