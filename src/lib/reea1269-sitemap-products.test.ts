/**
 * REEA-1269 (Bet 1b) — the sitemap inventory fold.
 *
 * The measured defect: `/sitemap.xml` advertised 6 product URLs (the bundled
 * catalog seeds that happened to answer a PDP check) while the products the
 * live fan-out already collects were never listed; and the iPhone key it did
 * advertise (`/product/iphone-17-pro`) was a different key from the shelf's
 * canonical one (`/product/apple-iphone17-pro-256gb`).
 *
 * These pins fix the fold that turns the durable live observation store into
 * canonical PDP keys:
 *  - one canonical key per SKU (the two iPhone keys collapse onto the catalog
 *    identity the PDP canonicalises to);
 *  - every entry carries the live observation stamp it came from;
 *  - observations outside the window are dropped (S-4 honesty: a listed URL
 *    traces to a recent live round);
 *  - the cap bounds the payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenSnapshot } from "@/lib/collect/last-seen";

const mocks = vi.hoisted(() => ({
  readSnapshots: vi.fn(),
  getSharedKv: vi.fn(),
  diskQueries: vi.fn(),
}));

vi.mock("@/lib/collect/last-seen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collect/last-seen")>();
  return {
    ...actual,
    readLatestSeenSnapshots: mocks.readSnapshots,
    diskCollectedQueries: mocks.diskQueries,
  };
});

vi.mock("@/lib/collect/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collect/kv")>();
  return { ...actual, getSharedKv: mocks.getSharedKv };
});

const {
  foldStoredRounds,
  collectedQueries,
  resetSitemapProductsForTests,
  SITEMAP_PRODUCT_CAP,
  SITEMAP_PRODUCT_QUERY_LIMIT,
} = await import("@/lib/sitemap-products");

const NOW = Date.parse("2026-11-27T21:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function hit(over: Record<string, unknown>) {
  return {
    merchant: "Xcite",
    price: 100,
    currency: "KWD",
    url: "https://www.xcite.com/p",
    inStock: true,
    country: "KW" as const,
    collectedAt: iso(60 * 60 * 1000),
    ...over,
  };
}

function snapshot(query: string, merchant: string, hits: unknown[], over: Partial<SeenSnapshot> = {}) {
  return {
    query,
    merchant,
    collectedAt: iso(60 * 60 * 1000),
    hits,
    days: [],
    ...over,
  } as unknown as SeenSnapshot;
}

beforeEach(() => {
  mocks.readSnapshots.mockReset();
  mocks.getSharedKv.mockReset();
  mocks.getSharedKv.mockReturnValue(null);
  mocks.diskQueries.mockReset();
  mocks.diskQueries.mockReturnValue([]);
  resetSitemapProductsForTests();
});

describe("REEA-1269 — sitemap inventory fold", () => {
  it("folds two live keys of one SKU onto the catalog's canonical identity", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("iphone 17 pro", "Xcite", [
        hit({
          title: "Apple iPhone 17 Pro 256GB Cosmic Orange",
          url: "https://www.xcite.com/apple-iphone-17-pro-256gb/p",
        }),
      ]),
      snapshot("iphone 17 pro", "Eureka", [
        hit({
          merchant: "Eureka",
          title: "Apple iPhone 17 Pro 256GB",
          url: "https://www.eureka.com.kw/products/details/275096",
        }),
      ]),
    ]);

    const products = await foldStoredRounds(["iphone 17 pro"], NOW);
    const ids = products.map((p) => p.canonicalId);
    // The live merge key is apple-iphone17-pro-256gb; the canonical identity the
    // PDP canonicalises to is the catalog id. Only ONE key is advertised.
    expect(ids).toContain("iphone-17-pro");
    expect(ids).not.toContain("apple-iphone17-pro-256gb");
    expect(ids.filter((id) => id === "iphone-17-pro")).toHaveLength(1);
  });

  it("carries the live observation stamp, never a fabricated one", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("sony", "Blink", [
        hit({
          merchant: "Blink",
          title: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
          url: "https://blink.com.kw/products/sony-wh-1000xm6",
          collectedAt: iso(2 * 60 * 60 * 1000),
        }),
      ]),
    ]);
    const products = await foldStoredRounds(["sony"], NOW);
    const sony = products.find((p) => p.canonicalId === "sony-wh-1000xm6");
    expect(sony).toBeDefined();
    expect(sony!.observedAtMs).toBe(NOW - 2 * 60 * 60 * 1000);
  });

  it("drops observations outside the window", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot(
        "sony",
        "Blink",
        [
          hit({
            merchant: "Blink",
            title: "Sony WH-1000XM6 Wireless Headphones",
            url: "https://blink.com.kw/products/sony-wh-1000xm6",
            // Older than the 3-day window the fold advertises.
            collectedAt: iso(4 * 24 * 60 * 60 * 1000),
          }),
        ],
        { collectedAt: iso(4 * 24 * 60 * 60 * 1000) },
      ),
    ]);
    const products = await foldStoredRounds(["sony"], NOW);
    expect(products).toHaveLength(0);
  });

  it("keeps the freshest stamp when one SKU was observed more than once", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("sony", "Blink", [
        hit({
          merchant: "Blink",
          title: "Sony WH-1000XM6 Wireless Headphones",
          url: "https://blink.com.kw/products/sony-wh-1000xm6",
          collectedAt: iso(30 * 60 * 60 * 1000),
        }),
      ]),
      snapshot(
        "sony headphones",
        "Xcite",
        [
          hit({
            title: "Sony WH-1000XM6 Wireless Headphones",
            url: "https://www.xcite.com/sony-wh-1000xm6/p",
            collectedAt: iso(10 * 60 * 1000),
          }),
        ],
        { collectedAt: iso(10 * 60 * 1000) },
      ),
    ]);
    const products = await foldStoredRounds(["sony", "sony headphones"], NOW);
    const matches = products.filter((p) => p.canonicalId === "sony-wh-1000xm6");
    expect(matches).toHaveLength(1);
    expect(matches[0].observedAtMs).toBe(NOW - 10 * 60 * 1000);
  });

  it("falls back to stored listing identities when the latest rounds are thin", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("air fryer", "Nest", [], {
        days: [
          {
            observedAt: iso(60 * 60 * 1000),
            offers: [
              {
                price: 39.9,
                currency: "KWD",
                country: "KW",
                identity: {
                  fields: {
                    brand: "philips",
                    modelLine: "air fryer xxl",
                    platform: "",
                    storage: "",
                    color: "",
                    grade: "",
                  },
                  accessory: false,
                },
              },
            ],
          },
        ],
      }),
    ]);
    const products = await foldStoredRounds(["air fryer"], NOW);
    expect(products.map((p) => p.canonicalId)).toContain("philips-air-fryer-xxl");
  });

  it("caps the advertised inventory", async () => {
    const snapshots: SeenSnapshot[] = [];
    const queries = Array.from({ length: 60 }, (_, i) => `Brand${i} Model${i}`);
    for (let i = 0; i < 60; i++) {
      snapshots.push(
        snapshot(queries[i], "Xcite", [
          hit({
            title: `Brand${i} Model${i} 128GB`,
            url: `https://www.xcite.com/brand${i}-model${i}-128gb/p`,
          }),
        ]),
      );
    }
    mocks.readSnapshots.mockResolvedValue(snapshots);
    const products = await foldStoredRounds(queries, NOW);
    expect(products.length).toBeLessThanOrEqual(SITEMAP_PRODUCT_CAP);
    expect(products.length).toBeGreaterThan(0);
  });

  it("never throws when the store fails — the sitemap keeps its catalog seeds", async () => {
    mocks.readSnapshots.mockRejectedValue(new Error("kv down"));
    await expect(foldStoredRounds(["sony"], NOW)).resolves.toEqual([]);
  });

  it("ranks the collected queries by lane coverage and bounds the read", async () => {
    mocks.getSharedKv.mockReturnValue({
      keys: vi.fn().mockResolvedValue([
        "seen:Xcite:iphone 17 pro",
        "seen:Blink:iphone 17 pro",
        "seen:Eureka:iphone 17 pro",
        "seen:Xcite:air fryer",
        "seen:Jarir:air fryer",
        "seen:Blink:headphones",
      ]),
    });
    const queries = await collectedQueries(2);
    expect(queries).toEqual(["iphone 17 pro", "air fryer"]);
    expect(queries.length).toBeLessThanOrEqual(2);
    expect(SITEMAP_PRODUCT_QUERY_LIMIT).toBeGreaterThan(0);
  });

  it("discovers collected queries from the degraded disk layer too", async () => {
    mocks.diskQueries.mockReturnValue(["air fryer", "air fryer", "panadol"]);
    const queries = await collectedQueries(2);
    expect(queries).toEqual(["air fryer", "panadol"]);
  });

  it("does not let the collected-query discovery fail the fold", async () => {
    mocks.getSharedKv.mockReturnValue({
      keys: vi.fn().mockRejectedValue(new Error("keyspace unavailable")),
    });
    mocks.readSnapshots.mockResolvedValue([
      snapshot("sony", "Blink", [
        hit({
          merchant: "Blink",
          title: "Sony WH-1000XM6 Wireless Headphones",
          url: "https://blink.com.kw/products/sony-wh-1000xm6",
        }),
      ]),
    ]);
    const products = await foldStoredRounds(["sony"], NOW);
    expect(products.map((p) => p.canonicalId)).toContain("sony-wh-1000xm6");
  });
});
