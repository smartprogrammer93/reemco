/**
 * REEA-1238 — the rev-2 gate misses this ticket fixes:
 *
 *  - the served shelf froze on the FIRST flushes' single-retailer cards, so
 *    the merged comparison cards the run produced later could never paint
 *    (median comparison breadth 8.6% / 5.7% instead of the rev-2 20%);
 *  - a pinned pair whose second retailer is cross-market (Panadol pack at
 *    Danube Home + BinSina) was classed as a single and dropped by the
 *    two-single category tail, so AC 7B-2b missed in EN;
 *  - the coverage aggregate's failed count could exceed the lanes it named
 *    when an errored lane still rendered prices (AC 7B-4 copy defect).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedProduct } from "@/types/product";

process.env.METRICS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-metrics-1238-"));
process.env.EVENTS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-events-1238-"));
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const {
  CATEGORY_SHELF_CARDS,
  freshCardsForFlush,
  paintedIdsAfter,
  paintedShelfCardsAcrossStages,
} = await import("@/lib/results-shelf");
const { coverageLine } = await import("@/lib/collect/coverage");
const { groupHits } = await import("@/lib/collect/live-search");

type P = NormalizedProduct;

function offer(merchant: string, price: number, currency = "KWD") {
  return {
    merchant,
    price,
    currency,
    url: `https://example.test/${merchant.toLowerCase()}/${price}`,
    inStock: true,
  };
}

function product(productId: string, title: string, offers: ReturnType<typeof offer>[]): P {
  return {
    productId,
    title,
    brand: "Test",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
    productScope: "primary",
  };
}

const singleA = product("single-a", "Single A", [offer("Xcite", 10)]);
const singleB = product("single-b", "Single B", [offer("Eureka", 12)]);
const comparison = product("comparison-c", "Comparison C", [offer("Xcite", 20), offer("Blink", 21)]);
const crossMarketPair = product("pair-d", "Pair D", [offer("Danube Home", 3, "SAR"), offer("BinSina", 1.2)]);

describe("REEA-1238 — the category paint chain reserves slots for comparisons", () => {
  it("an intermediate category flush paints comparison cards only", () => {
    const fresh = freshCardsForFlush(
      [singleA, singleB, comparison],
      new Set(),
      false,
      CATEGORY_SHELF_CARDS,
      { comparisonFirst: true, finalFlush: false },
    );
    expect(fresh.map((p) => p.productId)).toEqual([comparison.productId]);
  });

  it("the final category flush spends the remaining slots on the comparison-led shelf", () => {
    const painted = paintedIdsAfter(
      new Set(),
      freshCardsForFlush([singleA], new Set(), false, CATEGORY_SHELF_CARDS, {
        comparisonFirst: true,
        finalFlush: false,
      }),
    );
    // The early flush had no comparison, so nothing was painted.
    expect(painted.size).toBe(0);
    const final = freshCardsForFlush(
      [comparison, crossMarketPair, singleA, singleB],
      painted,
      false,
      CATEGORY_SHELF_CARDS,
      { comparisonFirst: true, finalFlush: true },
    );
    expect(final.map((p) => p.productId)).toEqual([
      comparison.productId,
      crossMarketPair.productId,
      singleA.productId,
      singleB.productId,
    ]);
  });

  it("the metrics fold applies the same policy as the renderer", async () => {
    const stages = [
      Promise.resolve({ products: [singleA, singleB], replay: false }),
      Promise.resolve({ products: [comparison, singleA, singleB], replay: false }),
    ];
    const painted = await paintedShelfCardsAcrossStages(
      stages,
      "headphones",
      1,
      null,
      false,
    );
    // The first flush painted nothing (no comparison); the final flush led
    // with the comparison and filled the remaining slots with singles.
    expect(painted.map((p) => p.productId)).toEqual([
      comparison.productId,
      singleA.productId,
      singleB.productId,
    ]);
  });

  it("an exact-model shelf keeps the pre-change append rule", async () => {
    const stages = [
      Promise.resolve({ products: [singleA, singleB], replay: false }),
      Promise.resolve({ products: [comparison, singleA, singleB], replay: false }),
    ];
    const painted = await paintedShelfCardsAcrossStages(
      stages,
      "iphone 17 pro",
      1,
      null,
      false,
    );
    expect(painted.map((p) => p.productId)).toEqual([
      singleA.productId,
      singleB.productId,
      comparison.productId,
    ]);
  });
});

describe("REEA-1238 AC 7B-2b — a cross-market pinned pair stays on the shelf", () => {
  const hit = (o: {
    title: string;
    merchant: string;
    price: number;
    currency: string;
    url: string;
  }) => ({
    title: o.title,
    merchant: o.merchant,
    price: o.price,
    currency: o.currency,
    url: o.url,
    inStock: true,
    country: o.currency === "KWD" ? ("KW" as const) : ("SA" as const),
    scrapedAt: "2026-11-26T00:00:00.000Z",
  });

  it("keeps the Danube Home + BinSina Panadol pack as one card on the category shelf", () => {
    const products = groupHits(
      "panadol",
      [
        hit({
          title: "Panadol Extra Pain Relief Tablets 24tablets",
          merchant: "Danube Home",
          price: 3,
          currency: "SAR",
          url: "https://danube.example/panadol-24",
        }),
        hit({
          title: "Panadol Extra Optizorb Tablets 24's",
          merchant: "BinSina",
          price: 1.2,
          currency: "KWD",
          url: "https://binsina.example/panadol-24",
        }),
        hit({
          title: "Panadol Sinus Caplets 24's",
          merchant: "Aster Pharmacy",
          price: 1.5,
          currency: "KWD",
          url: "https://aster.example/panadol-sinus",
        }),
      ],
      true,
      "en",
      true,
    );
    const pair = products.find((p) => p.offers.some((o) => o.merchant === "Danube Home"));
    expect(pair).toBeDefined();
    expect(new Set(pair!.offers.map((o) => o.merchant))).toEqual(
      new Set(["Danube Home", "BinSina"]),
    );
  });

  it("keeps ONE single tail slot so a one-comparison query clears the 40% gate", () => {
    // REEA-1238 AC 7B-2R — the median serve painted one comparison plus two
    // singles (1/3 = 33%). The comparison band owns the second slot instead,
    // so the same evidence paints 1/2 = 50% and the per-query gate passes.
    const products = groupHits(
      "headphones",
      [
        hit({
          title: "Sony WH-1000XM5 Wireless Headphones",
          merchant: "Blink",
          price: 89.9,
          currency: "KWD",
          url: "https://blink.example/xm5",
        }),
        hit({
          title: "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black",
          merchant: "Xcite",
          price: 94.9,
          currency: "KWD",
          url: "https://xcite.example/xm5",
        }),
        hit({
          title: "JBL Tune 520BT Wireless Headphones",
          merchant: "Jarir",
          price: 15,
          currency: "SAR",
          url: "https://jarir.example/jbl",
        }),
        hit({
          title: "Anker Soundcore Q30 Headphones",
          merchant: "Wibi",
          price: 24.9,
          currency: "KWD",
          url: "https://wibi.example/anker",
        }),
      ],
      true,
      "en",
      true,
    );
    // One comparison (Blink+Xcite) + ONE single tail (not two).
    expect(products).toHaveLength(2);
    expect(new Set(products[0].offers.map((o) => o.merchant))).toEqual(
      new Set(["Blink", "Xcite"]),
    );
  });
});

describe("REEA-1238 AC 7B-4 — the coverage failed count matches the named lanes", () => {
  const rendered = (merchant: string): NormalizedProduct => ({
    productId: `p-${merchant}`,
    title: "Panadol Extra 24 tablets",
    brand: "Panadol",
    offers: [{ merchant, price: 1.2, currency: "KWD", url: `https://x/${merchant}`, inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
  });

  it("does not count an errored-but-rendering lane as failed", () => {
    const notes = [
      { merchant: "Xcite", hits: 2 },
      { merchant: "BinSina", hits: 1 },
      { merchant: "Amazon.eg", hits: 1, error: "HTTP 503" },
      { merchant: "Next Store", hits: 0, error: "blocked: challenge shell" },
      { merchant: "Ounass", hits: 0 },
    ];
    const line = coverageLine(
      notes,
      "en",
      [rendered("Xcite"), rendered("BinSina"), rendered("Amazon.eg")],
      ["Ounass"],
    );
    // 3 lanes rendered (Amazon.eg included), Next Store + Ounass are the two
    // named gaps. The aggregate must say 2 failed, not 3.
    expect(line).toContain("5 stores checked");
    expect(line).toContain("3 carry this");
    expect(line).toContain("2 failed");
    expect(line).toContain("Unreachable: Next Store and Ounass");
    expect(line).not.toContain("No response from Amazon.eg");
  });
});
