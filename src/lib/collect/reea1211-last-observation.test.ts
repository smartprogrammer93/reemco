/**
 * REEA-1211 — the catalog-PDP seed from the last verified observation.
 *
 * A catalog seed carries no collection stamp, so the PDP never inherits its
 * bundled row. When the identity's only listing is unreliable (the measured
 * keychron-v3-max: one amazon.eg search listing answering HTTP 503) the first
 * paint was an empty offer table on a sitemap-advertised URL. The store's last
 * COMPLETED collection is real evidence with its own collectedAt, so the page
 * seeds it — labelled as an earlier run's answer, never as this run's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";

const mocks = vi.hoisted(() => ({ findLastCompleted: vi.fn() }));

vi.mock("@/lib/collect/store", () => ({
  findLastCompleted: mocks.findLastCompleted,
}));

const { hasCollectionStamp, lastVerifiedObservation, seedCatalogPageWithLastObservation } =
  await import("@/lib/collect/last-observation");

function product(offers: NormalizedProduct["offers"]): NormalizedProduct {
  return {
    productId: "keychron-v3-max",
    title: "Keychron V3 Max QMK Wireless Mechanical Keyboard",
    brand: "Keychron",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function job(offers: CollectJob["offers"]): CollectJob {
  return {
    jobId: "job-reea1211",
    productId: "keychron-v3-max",
    status: "complete",
    mode: "live",
    startedAt: "2026-11-26T08:00:00.000Z",
    finishedAt: "2026-11-26T08:00:05.000Z",
    subtasks: [],
    offers,
  };
}

const observed = {
  merchant: "Amazon.eg (ships to KW)",
  domain: "amazon.eg",
  price: 3698.91,
  currency: "EGP",
  url: "https://www.amazon.eg/dp/B0DPWX3WTL",
  inStock: true,
  collectedAt: "2026-11-26T08:00:05.000Z",
  collectedAtEpochMs: Date.parse("2026-11-26T08:00:05.000Z"),
  method: "live" as const,
};

const unstampedSeed = {
  merchant: "Amazon.eg (ships to KW)",
  price: 33.5,
  currency: "KWD",
  url: "https://www.amazon.eg/s?k=Keychron%20V3%20Max",
  inStock: true,
};

beforeEach(() => {
  mocks.findLastCompleted.mockReset();
});

describe("REEA-1211 — seed a catalog page from its last verified observation", () => {
  it("paints the stored observation instead of an empty table when the live lane is down", async () => {
    mocks.findLastCompleted.mockResolvedValue(job([observed]));
    const seeded = await seedCatalogPageWithLastObservation(product([unstampedSeed]));
    expect(seeded.offers).toHaveLength(1);
    expect(seeded.offers[0].collectedAt).toBe(observed.collectedAt);
    // The row is an EARLIER run's answer: it must not borrow this run's
    // "Verified — cross-checked during this collection run" claim.
    expect((seeded.offers[0] as unknown as { method?: string }).method).toBe("cache");
    expect(hasCollectionStamp(seeded.offers[0])).toBe(true);
  });

  it("leaves the identity untouched when the store has no completed observation", async () => {
    mocks.findLastCompleted.mockResolvedValue(undefined);
    const seed = product([unstampedSeed]);
    const seeded = await seedCatalogPageWithLastObservation(seed);
    expect(seeded).toBe(seed);
    expect(seeded.offers[0].collectedAt).toBeUndefined();
  });

  it("ignores a completed job that carries no offers", async () => {
    mocks.findLastCompleted.mockResolvedValue(job([]));
    const seed = product([unstampedSeed]);
    expect(await seedCatalogPageWithLastObservation(seed)).toBe(seed);
    expect(await lastVerifiedObservation("keychron-v3-max")).toBeNull();
  });

  it("keeps the shelf's query-time rows when they already carry a stamp", async () => {
    const stamped = { ...unstampedSeed, collectedAt: "2026-11-26T08:10:00.000Z" };
    const seed = product([stamped]);
    const seeded = await seedCatalogPageWithLastObservation(seed);
    expect(seeded).toBe(seed);
    // The shelf's answer is the fresher, exact one — no store read needed.
    expect(mocks.findLastCompleted).not.toHaveBeenCalled();
  });

  it("fail-opens when the store read throws", async () => {
    mocks.findLastCompleted.mockRejectedValue(new Error("kv down"));
    const seed = product([unstampedSeed]);
    expect(await seedCatalogPageWithLastObservation(seed)).toBe(seed);
    expect(await lastVerifiedObservation("keychron-v3-max")).toBeNull();
  });
});
