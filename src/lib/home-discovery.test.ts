/**
 * REEA-1070 AC1/AC2/AC7/AC10 — the pure home discovery projection.
 *
 * Every module item must be traceable to a live snapshot in the input; empty,
 * no-response and partial states must be explicit instead of invented
 * merchandise. These pins also carry the named savings baseline and the
 * epoch timestamps the EN/AR UI humanises.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedProduct } from "@/types/product";
import type { LiveSearchResult, ResponderSummary } from "@/lib/collect/coverage";
import { summarizeResponders } from "@/lib/collect/coverage";
import {
  buildHomeDiscovery,
  categoryOfTitle,
  HOME_DISCOVERY_COPY,
  type HomeDiscoverySnapshot,
} from "@/lib/home-discovery";

const disclosure = { en: "disclosure", ar: "إفصاح" };

function offer(
  merchant: string,
  price: number,
  currency: string,
  wasPrice?: number,
  collectedAtEpochMs = Date.parse("2026-11-23T12:00:00Z"),
) {
  return {
    merchant,
    price,
    currency,
    url: `https://example.test/${merchant}/${price}`,
    inStock: true,
    ...(wasPrice != null ? { wasPrice } : {}),
    collectedAt: new Date(collectedAtEpochMs).toISOString(),
    collectedAtEpochMs,
  };
}

function product(
  productId: string,
  title: string,
  offers: NormalizedProduct["offers"],
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "Brand",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-23T12:00:00.000Z",
    scrapedAtEpochMs: Date.parse("2026-11-23T12:00:00.000Z"),
  };
}

function snapshot(
  query: string,
  notes: LiveSearchResult["notes"],
  products: NormalizedProduct[],
  settled = true,
): HomeDiscoverySnapshot {
  const responders: ResponderSummary = summarizeResponders(notes);
  return {
    query,
    snap: {
      products,
      notes,
      responders,
      collectedAt: "2026-11-23T12:00:00.000Z",
      collectedAtEpochMs: Date.parse("2026-11-23T12:00:00.000Z"),
      ...(settled ? {} : { settled: false }),
    },
  };
}

describe("buildHomeDiscovery (REEA-1070 AC1)", () => {
  it("populates every module from the live snapshot, with named baselines", () => {
    const phone = product("apple-iphone-17-pro", "Apple iPhone 17 Pro 256GB", [
      offer("Xcite", 189.9, "KWD", 214),
      offer("Blink", 214.9, "KWD"),
    ]);
    const audio = product("sony-wh-1000xm6", "Sony WH-1000XM6 Headphones", [
      offer("Eureka", 329, "KWD", 349),
    ]);
    const snap = snapshot(
      "iphone 17 pro",
      [
        { merchant: "Xcite", hits: 2, coupons: 1 },
        { merchant: "Blink", hits: 1 },
        { merchant: "Jarir", hits: 0, error: "no answer within the 1800 ms completion budget" },
      ],
      [phone, audio],
    );

    const data = buildHomeDiscovery([snap], disclosure);

    expect(data.status).toBe("live");
    expect(data.partial).toBe(false);
    expect(data.collectedAt).toBe("2026-11-23T12:00:00.000Z");
    expect(data.collectedAtEpochMs).toBe(Date.parse("2026-11-23T12:00:00Z"));

    // AC2 — per-query responder truth names both groups.
    expect(data.queries).toHaveLength(1);
    expect(data.queries[0].responders).toEqual({
      queried: ["Xcite", "Blink", "Jarir"],
      answered: ["Xcite", "Blink"],
      answeredEmpty: [],
      noResponse: ["Jarir"],
    });
    expect(data.queries[0].offers).toBe(3);

    // AC1 — retailer strip is per-retailer live truth, never a static list.
    expect(data.retailerStrip.status).toBe("live");
    expect(data.retailerStrip.items).toEqual([
      expect.objectContaining({ merchant: "Xcite", state: "live", offers: 2, answeredQueries: 1 }),
      expect.objectContaining({ merchant: "Blink", state: "live", offers: 1 }),
      expect.objectContaining({ merchant: "Jarir", state: "no-response", offers: 0, noResponseQueries: 1 }),
    ]);

    // AC7 — a drop only exists with struck − current and a named baseline.
    expect(data.priceDrops.status).toBe("live");
    expect(data.priceDrops.items).toHaveLength(2);
    const biggest = data.priceDrops.items[0];
    expect(biggest.savings.amount).toBe(24.1);
    expect(biggest.savings.baseline).toEqual({
      merchant: "Xcite",
      listedPrice: 214,
      currency: "KWD",
      kind: "was_price",
      observedAt: "2026-11-23T12:00:00.000Z",
      url: "https://example.test/Xcite/189.9",
    });
    expect(biggest.checkedAtEpochMs).toBe(Date.parse("2026-11-23T12:00:00Z"));
    expect(biggest.href).toBe("/product/apple-iphone-17-pro");

    // AC1 — categories come from the live titles this run collected.
    expect(data.categories.status).toBe("live");
    expect(data.categories.items.map((c) => [c.id, c.count])).toEqual([
      ["phones", 1],
      ["audio", 1],
    ]);

    // Method band carries live stats + both disclosure locales.
    expect(data.methodBand.offers).toBe(3);
    expect(data.methodBand.coupons).toBe(1);
    expect(data.methodBand.retailersAnswered).toBe(2);
    expect(data.methodBand.retailersQueried).toBe(3);
    expect(data.methodBand.disclosure).toEqual(disclosure);
    expect(data.methodBand.provenance.queries).toEqual(["iphone 17 pro"]);
  });

  it("reports an honest empty state instead of filler", () => {
    const snap = snapshot("nothing", [{ merchant: "Xcite", hits: 0 }], []);
    const data = buildHomeDiscovery([snap], disclosure);
    expect(data.status).toBe("empty");
    expect(data.retailerStrip.status).toBe("empty");
    expect(data.retailerStrip.reason).toBe("no-live-offers");
    expect(data.priceDrops).toEqual({
      status: "empty",
      items: [],
      reason: "no-live-offers",
      partial: false,
    });
    expect(data.categories.status).toBe("empty");
    expect(data.methodBand.status).toBe("live");
    expect(data.methodBand.offers).toBe(0);
  });

  it("reports no-response when a query produced no snapshot at all", () => {
    const data = buildHomeDiscovery([{ query: "iphone", snap: null }], disclosure);
    expect(data.status).toBe("no-response");
    expect(data.partial).toBe(true);
    expect(data.retailerStrip.status).toBe("no-response");
    expect(data.priceDrops.status).toBe("no-response");
    expect(data.categories.status).toBe("no-response");
    expect(data.methodBand.status).toBe("no-response");
    expect(data.queries[0].responders).toEqual({
      queried: [],
      answered: [],
      answeredEmpty: [],
      noResponse: [],
    });
  });

  it("marks a finalized-at-budget snapshot as partial", () => {
    const snap = snapshot("iphone", [{ merchant: "Xcite", hits: 1 }], [
      product("p", "Apple iPhone 17 Pro", [offer("Xcite", 189.9, "KWD", 214)]),
    ], false);
    const data = buildHomeDiscovery([snap], disclosure);
    expect(data.partial).toBe(true);
    expect(data.queries[0].settled).toBe(false);
    expect(data.priceDrops.partial).toBe(true);
  });

  it("has a loading status constant the UI can render before the stream lands", () => {
    expect(HOME_DISCOVERY_COPY.en.priceDropsTitle).toBe("Price drops right now");
    expect(HOME_DISCOVERY_COPY.ar.priceDropsTitle).toBe("انخفاضات الأسعار الآن");
  });
});

describe("categoryOfTitle (REEA-1070 AC1)", () => {
  it("classifies live titles without a bundled product catalogue", () => {
    expect(categoryOfTitle("Apple iPhone 17 Pro 256GB")).toBe("phones");
    expect(categoryOfTitle("Sony WH-1000XM6 Wireless Headphones")).toBe("audio");
    expect(categoryOfTitle("ASUS VivoBook 15 Laptop")).toBe("computing");
    expect(categoryOfTitle("Samsung 65 inch Smart TV")).toBe("tv");
    expect(categoryOfTitle("Philips Air Fryer XL")).toBe("home");
    expect(categoryOfTitle("PlayStation 5 Console")).toBe("gaming");
    expect(categoryOfTitle("Country XL Organic Basmati Rice")).toBeNull();
  });
});
