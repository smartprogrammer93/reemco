/**
 * REEA-1280 — the served results document must not carry payload the results
 * renderer never reads.
 *
 * Measured on the served head: a cold `iphone 17 pro` document was ~792 KB.
 * ~165 KB of that was the collector's per-stage `suggestions` (three full
 * product objects, offers included, on EVERY stage) plus `responders`, and
 * neither is rendered by ResultsClient — the empty-state pills come from the
 * static lexicon/strings (REEA-1218) and the coverage line reads `notes`.
 * The browser downloaded/parsed all of it before the first card could paint.
 *
 * These pin the strip on every served stage (including the last) and prove it
 * cannot mutate the collector's own snapshot objects (the memo write and the
 * counters read the same objects).
 */
import { describe, expect, it } from "vitest";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import type { NormalizedProduct } from "@/types/product";
import { trimStagesToPaintedDiff } from "@/lib/results-shelf";

type P = NormalizedProduct;

function offer(merchant: string, price: number) {
  return {
    merchant,
    price,
    currency: "KWD" as const,
    url: `https://example.test/${merchant.toLowerCase()}/${price}`,
    inStock: true,
  };
}

function product(productId: string, title: string, offers: ReturnType<typeof offer>[]): P {
  return {
    productId,
    title,
    brand: "Apple",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
    productScope: "primary",
  };
}

const responders = {
  queried: ["Xcite", "Blink"],
  answered: ["Xcite"],
  answeredEmpty: [],
  noResponse: ["Blink"],
};

function snapshot(products: P[]): LiveSearchResult {
  return {
    products,
    notes: [{ merchant: "Xcite", hits: products.length }],
    responders,
    suggestions: products.slice(0, 3),
    collectedAt: "2026-11-26T00:00:00.000Z",
    collectedAtEpochMs: 1,
    settled: false,
  };
}

const a = product("iphone-17-pro", "Apple iPhone 17 Pro 256GB", [offer("Xcite", 499)]);
const b = product("iphone-17-pro-max", "Apple iPhone 17 Pro Max 256GB", [
  offer("Xcite", 599),
  offer("Blink", 610),
]);

describe("REEA-1280 — served stages drop payload the results renderer never reads", () => {
  it("strips suggestions and responders from every served stage, the last included", async () => {
    const stages = [Promise.resolve(snapshot([a])), Promise.resolve(snapshot([a, b]))];
    const trimmed = trimStagesToPaintedDiff(stages, "iphone 17 pro", 1, "KW", false);
    for (const stage of trimmed) {
      const snap = await stage;
      expect(snap.suggestions).toEqual([]);
      expect(snap.responders).toBeUndefined();
    }
    // The converged view still reads the last stage's full product set.
    const last = await trimmed[1];
    expect(last.products.map((p) => p.productId)).toEqual([a.productId, b.productId]);
  });

  it("does not mutate the collector's own snapshot objects", async () => {
    const first = snapshot([a]);
    const last = snapshot([a, b]);
    const trimmed = trimStagesToPaintedDiff(
      [Promise.resolve(first), Promise.resolve(last)],
      "iphone 17 pro",
      1,
      "KW",
      false,
    );
    await Promise.all(trimmed);
    // The memo write and the counters read these same objects: the strip must
    // hand back a copy, never blank the source.
    expect(first.suggestions?.length).toBeGreaterThan(0);
    expect(last.suggestions?.length).toBeGreaterThan(0);
    expect(first.responders).toEqual(responders);
    expect(last.responders).toEqual(responders);
  });

  it("strips on page 2+ snapshots too", async () => {
    const trimmed = trimStagesToPaintedDiff(
      [Promise.resolve(snapshot([a, b]))],
      "iphone 17 pro",
      2,
      "KW",
      false,
    );
    const snap = await trimmed[0];
    expect(snap.suggestions).toEqual([]);
    expect(snap.responders).toBeUndefined();
    expect(snap.products.map((p) => p.productId)).toEqual([a.productId, b.productId]);
  });

  it("keeps a snapshot with nothing to strip as-is", async () => {
    const bare: LiveSearchResult = { products: [a], notes: [] };
    const trimmed = trimStagesToPaintedDiff(
      [Promise.resolve(bare)],
      "iphone 17 pro",
      1,
      "KW",
      false,
    );
    expect(await trimmed[0]).toBe(bare);
  });
});
