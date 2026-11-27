import { afterEach, describe, expect, it } from "vitest";
import { finishJob, resetStoreForTests } from "@/lib/collect/store";
import { exactModelShelfSeed } from "@/lib/collect/last-observation";
import { withExactModelCard } from "@/lib/exact-model-seed";
import { comparisonDepthOf } from "@/lib/metrics";
import { coverageLine } from "@/lib/collect/coverage";
import { resultsShelfSections } from "@/lib/results-shelf";
import { carriesExactModel, exactModelQuery } from "@/lib/relevance";
import { classifyProductScope } from "@/lib/scope-gate";
import {
  exactModelCardsOf,
  exactModelCountText,
  exactModelOnlyOutsideMarket,
  isExactModelQuery,
} from "@/lib/shelf-honesty";
import type { LiveOffer } from "@/lib/collect/types";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/**
 * REEA-1261 — the shelf substituted a different brand when the exact model had
 * no in-market offer (live `ffaf8fd`: `keychron v3 max` painted 9/9 Razer
 * cards and zero Keychron while the PDP showed the exact product with an
 * Egypt-only price).
 *
 * These are the smallest proving checks for the two causes and the four
 * surfaces that must agree: the scope gate (brand+model identity), the shelf
 * chain (exact card leads, neighbours go to the labelled related band), the
 * count line (exact-model cards only, with the "none in Kuwait" disclosure),
 * the seeded card (same last-observation evidence the PDP uses) and the
 * comparison-depth fold (cross-market-only cards are counted, AC-5).
 */

const razerTitles = [
  "RAZER ORNATA V3 TKL RGB Wired Mecha-Membrane Keyboard - Black",
  "RAZER HUNTSMAN V3 Tenkeyless 8KHz Analog Optical Esports Wired Gaming Keyboard - Black",
  "RAZER DeathAdder V3 Pro Wireless Gaming Mouse - Black",
];

const kwOffer = (merchant: string, price: number): PriceOffer => ({
  merchant,
  price,
  currency: "KWD",
  market: "KW",
  url: `https://example.test/${merchant}/${price}`,
  inStock: true,
  collectedAt: new Date().toISOString(),
  method: "live",
} as unknown as PriceOffer);

const egOffer = (price: number): PriceOffer => ({
  merchant: "Amazon.eg",
  price,
  currency: "EGP",
  market: "EG",
  url: "https://www.amazon.eg/dp/B0EXAMPLE",
  inStock: true,
  collectedAt: new Date().toISOString(),
  method: "cache",
} as unknown as PriceOffer);

const liveProduct = (
  productId: string,
  title: string,
  offers: PriceOffer[],
): NormalizedProduct =>
  ({
    productId,
    title,
    brand: title.split(" ")[0],
    offers,
    ...classifyProductScope("keychron v3 max", title),
    alternatives: [],
    variations: [],
    coupons: [],
  }) as unknown as NormalizedProduct;

/** The catalog seed identity, as the PDP resolves it. */
const keychronCard = (offers: PriceOffer[]): NormalizedProduct =>
  ({
    productId: "keychron-v3-max",
    title: "Keychron V3 Max QMK Wireless Mechanical Keyboard",
    brand: "Keychron",
    offers,
    alternatives: [],
    variations: [],
    coupons: [],
    ...classifyProductScope("keychron v3 max", "Keychron V3 Max QMK Wireless Mechanical Keyboard"),
  }) as unknown as NormalizedProduct;

afterEach(() => {
  resetStoreForTests();
});

describe("AC-1 — brand+model identity is required (the substitution cause)", () => {
  it("stamps a Razer V3 as NOT primary for a Keychron V3 Max query", () => {
    const verdict = classifyProductScope("keychron v3 max", razerTitles[0]);
    expect(verdict.productScope).not.toBe("primary");
    expect(verdict.matchReason).toBe("related");
  });

  it("keeps the exact Keychron card primary", () => {
    const verdict = classifyProductScope(
      "keychron v3 max",
      "Keychron V3 Max QMK Wireless Mechanical Keyboard",
    );
    expect(verdict.productScope).toBe("primary");
    expect(verdict.matchReason).toBe("query_token");
  });

  it("still accepts a model-only query with no curated brand (no regression)", () => {
    // "iphone 17 pro" names no curated brand word; the model ladder is untouched.
    expect(exactModelQuery("iphone 17 pro")).toBeNull();
    expect(
      classifyProductScope("iphone 17 pro", "Apple iPhone 17 Pro 256GB").productScope,
    ).toBe("variant");
    // Category and brand-only queries keep the pre-change path too.
    expect(exactModelQuery("laptop")).toBeNull();
    expect(exactModelQuery("keychron")).toBeNull();
    expect(exactModelQuery("keychron v3 max")).toEqual({
      brand: "Keychron",
      models: ["v3"],
    });
    expect(carriesExactModel("keychron v3 max", razerTitles[0])).toBe(false);
    expect(
      carriesExactModel("keychron v3 max", "Keychron V3 Max QMK Wireless Mechanical Keyboard"),
    ).toBe(true);
  });
});

describe("AC-1/AC-3 — the shelf: exact model leads, neighbours go to the labelled band", () => {
  const razers = razerTitles.map((title, i) =>
    liveProduct(`razer-${i}`, title, [kwOffer("Quadra Stores", 21.9 + i)]),
  );
  const snapshot = [
    ...razers,
    keychronCard([egOffer(700)]),
  ];

  it("paints the exact model first, above every unrelated-brand card", () => {
    const sections = resultsShelfSections(
      { products: snapshot },
      "keychron v3 max",
      "KW",
      false,
    );
    expect(sections.primary[0]?.productId).toBe("keychron-v3-max");
    expect(sections.primary.every((p) => carriesExactModel("keychron v3 max", p.title))).toBe(true);
    // The neighbours are never peer cards: they sit in the labelled related
    // band, not in `primary` and not in the accessory band.
    expect(sections.related.map((p) => p.productId)).toEqual(
      razers.map((p) => p.productId),
    );
    expect(sections.accessory).toHaveLength(0);
  });

  it("is idempotent on a snapshot that already carries the exact card", () => {
    const once = withExactModelCard(snapshot, keychronCard([egOffer(700)]), "keychron v3 max");
    const twice = withExactModelCard(once, keychronCard([egOffer(700)]), "keychron v3 max");
    expect(twice.map((p) => p.productId)).toEqual(once.map((p) => p.productId));
    expect(twice.filter((p) => p.productId === "keychron-v3-max")).toHaveLength(1);
  });

  it("never overrides a live row that already answers the exact identity", () => {
    const liveExact = liveProduct(
      "keychron-v3-max-live",
      "Keychron V3 Max QMK Wireless Mechanical Keyboard",
      [kwOffer("Xcite", 39.9)],
    );
    const merged = withExactModelCard(
      [liveExact, ...razers],
      keychronCard([egOffer(700)]),
      "keychron v3 max",
    );
    expect(merged.map((p) => p.productId)).toEqual([
      "keychron-v3-max-live",
      ...razers.map((p) => p.productId),
    ]);
  });
});

describe("AC-2 — the count line counts the exact-model cards it renders", () => {
  const razers = razerTitles.map((title, i) =>
    liveProduct(`razer-${i}`, title, [kwOffer("Quadra Stores", 21.9 + i)]),
  );

  it("counts 1 for the cross-market-only exact card and discloses the market", () => {
    const cards = [keychronCard([egOffer(700)]), ...razers];
    const exact = exactModelCardsOf(cards, "keychron v3 max");
    expect(exact).toHaveLength(1);
    expect(isExactModelQuery("keychron v3 max")).toBe(true);
    expect(exactModelOnlyOutsideMarket(exact, "KW")).toBe(true);
    expect(exactModelCountText("en", exact.length, "Kuwait", true)).toBe(
      "1 retailer carries this model · none in Kuwait",
    );
    expect(exactModelCountText("en", exact.length, "Kuwait", false)).toBe(
      "1 retailer carries this exact model",
    );
  });

  it("does not claim the disclosure when the exact model is in market", () => {
    const inMarket = keychronCard([kwOffer("Xcite", 39.9)]);
    const exact = exactModelCardsOf([inMarket, ...razers], "keychron v3 max");
    expect(exact).toHaveLength(1);
    expect(exactModelOnlyOutsideMarket(exact, "KW")).toBe(false);
  });

  it("keeps the in-scope count on a category query (no regression)", () => {
    expect(exactModelCardsOf(razers, "laptop")).toHaveLength(0);
    expect(isExactModelQuery("laptop")).toBe(false);
  });
});

describe("AC-5 — cross-market-only cards are counted by comparison_depth", () => {
  it("counts a card whose only offers are KSA/EG stock", () => {
    const depth = comparisonDepthOf([keychronCard([egOffer(700)])], "KW");
    expect(depth.cardsTotal).toBe(1);
    expect(depth.cardsCrossMarket).toBe(1);
    expect(depth.cardsMultiRetailer).toBe(0);
  });
});

describe("AC-1 — the seeded exact-model card comes from a live observation", () => {
  it("returns null when the store holds no fresh observation", async () => {
    expect(await exactModelShelfSeed("keychron v3 max")).toBeNull();
  });

  it("returns the stored last observation, marked cache and stamped primary", async () => {
    const offer = {
      merchant: "Amazon.eg",
      domain: "amazon.eg",
      price: 700,
      currency: "EGP",
      market: "EG",
      url: "https://www.amazon.eg/dp/B0EXAMPLE",
      inStock: true,
      collectedAt: new Date().toISOString(),
      method: "live",
    } satisfies LiveOffer;
    await finishJob({
      jobId: "job-1261",
      productId: "keychron-v3-max",
      status: "complete",
      mode: "live",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      subtasks: [],
      offers: [offer],
    });
    const seed = await exactModelShelfSeed("keychron v3 max");
    expect(seed).not.toBeNull();
    expect(seed?.productId).toBe("keychron-v3-max");
    expect(seed?.productScope).toBe("primary");
    expect(seed?.offers).toHaveLength(1);
    expect(seed?.offers[0]?.merchant).toBe("Amazon.eg");
    // An earlier run's evidence never claims this run's cross-check.
    expect((seed?.offers[0] as unknown as { method?: string })?.method).toBe("cache");
    expect(seed?.offers[0]?.collectedAt).toBeTruthy();
  });

  it("returns null for a query that names no exact brand+model identity", async () => {
    expect(await exactModelShelfSeed("laptop")).toBeNull();
    expect(await exactModelShelfSeed("keychron")).toBeNull();
  });
});

describe("AC-2 — the coverage sentence counts the exact-model cards, not the lanes", () => {
  it("says 1 carries this exact model when four lanes answered the phrase", () => {
    const notes = [
      { merchant: "Quadra Stores", hits: 11, coupons: 0 },
      { merchant: "Jarir", hits: 6, coupons: 0 },
      { merchant: "Amazon.eg", hits: 1, coupons: 0 },
      { merchant: "Next Store", hits: 0, coupons: 0, error: "blocked" },
    ];
    const rendered = [
      keychronCard([egOffer(700)]),
      liveProduct("razer-0", razerTitles[0], [kwOffer("Quadra Stores", 21.9)]),
    ];
    // Pre-change wording (no exact-card count): the lane count, 3.
    expect(coverageLine(notes, "en", rendered, [], "keychron v3 max")).toContain(
      "3 carry this exact model",
    );
    // REEA-1261 AC-2: the sentence reads the painted exact-model cards.
    const honest = coverageLine(notes, "en", rendered, [], "keychron v3 max", false, 1);
    expect(honest).toContain("1 carries this exact model");
    expect(honest).not.toContain("3 carry");
    // A category query keeps the generic wording, count untouched.
    expect(coverageLine(notes, "en", rendered, [], "laptop")).toContain("carry this");
    expect(coverageLine(notes, "en", rendered, [], "laptop")).not.toContain("exact model");
  });
});
