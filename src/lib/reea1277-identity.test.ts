/**
 * REEA-1277 — a sitemap-listed live-only key must render its OWN product, not
 * a neighbour.
 *
 * Served-head defect (`d9e411c9`): the canonical tag was self-aligned on all
 * 287 listed URLs, but the PDP body resolved the slug through the live fan-out
 * and, when the exact id was absent from the run, fell back to a canonical
 * neighbour or `fallbackPool[0]` — `/product/sandisk-extreme-…` served an OPPO
 * A3 Pro and `/product/lenovo-gillette-256gb` served an Asus keyboard. The
 * sitemap mints those keys from stored live rounds and records the query that
 * minted each one; the resolver now re-derives the exact identity from that
 * same stored evidence (lib/pdp-stored-identity.ts) before accepting a
 * neighbour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedProduct } from "@/types/product";

const mocks = vi.hoisted(() => ({
  readLiveQueryMemo: vi.fn(),
  collectLiveResultsStagedAdmitted: vi.fn(),
  readRetiredLanes: vi.fn(),
  readPdpSource: vi.fn(),
  resolveStored: vi.fn(),
}));

vi.mock("@/lib/collect/live-search", () => ({
  collectLiveResults: vi.fn(),
  collectLiveResultsStagedAdmitted: mocks.collectLiveResultsStagedAdmitted,
  readLiveQueryMemo: mocks.readLiveQueryMemo,
  RESULTS_COMPLETION_BUDGET_MS: 1_800,
  STAGE_TAIL_HEADROOM_MS: 6_200,
}));
vi.mock("@/lib/collect/lane-health", () => ({
  readRetiredLanes: mocks.readRetiredLanes,
}));
vi.mock("@/lib/pdp-source", () => ({
  readPdpSource: mocks.readPdpSource,
  recordPdpSources: vi.fn(),
}));
vi.mock("@/lib/pdp-stored-identity", () => ({
  resolveStoredProductIdentity: mocks.resolveStored,
}));

const { resolveProductIdentity } = await import("@/lib/product-identity");

function product(productId: string, title: string): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers: [
      {
        merchant: "Eureka",
        price: 79.9,
        currency: "KWD",
        url: `https://www.eureka.com.kw/products/details/${productId}`,
        inStock: true,
        collectedAt: new Date().toISOString(),
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

const OPPO = product("oppo-pro-256gb", "OPPO A3 Pro 5G 256GB");
const SANDISK = product(
  "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
  "SanDisk Extreme PRO micro SDXC UHS-I Card Adapter 256GB",
);

beforeEach(() => {
  mocks.readLiveQueryMemo.mockReset();
  mocks.readLiveQueryMemo.mockReturnValue(null);
  mocks.collectLiveResultsStagedAdmitted.mockReset();
  mocks.readRetiredLanes.mockReset();
  mocks.readRetiredLanes.mockResolvedValue(new Set<string>());
  mocks.readPdpSource.mockReset();
  mocks.readPdpSource.mockResolvedValue(null);
  mocks.resolveStored.mockReset();
  mocks.resolveStored.mockResolvedValue(null);
});

describe("REEA-1277 — a listed key resolves to itself from stored evidence", () => {
  it("does not paint the oppo group on the sandisk sitemap URL", async () => {
    mocks.readPdpSource.mockResolvedValue("oppo a3 pro");
    mocks.collectLiveResultsStagedAdmitted.mockImplementation(async () => {
      const answer = { products: [OPPO] };
      return { final: Promise.resolve(answer), converged: Promise.resolve(answer) };
    });
    mocks.resolveStored.mockResolvedValue(SANDISK);

    const resolved = await resolveProductIdentity(
      "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.productId).toBe("sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb");
    expect(resolved!.title).toContain("SanDisk");
    // The stored resolver saw the minting query the sitemap recorded.
    expect(mocks.resolveStored).toHaveBeenCalledWith(
      "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
      expect.arrayContaining(["oppo a3 pro"]),
      expect.any(Number),
    );
  });

  it("keeps the requested identity when neither live nor stored evidence has it", async () => {
    mocks.readPdpSource.mockResolvedValue("oppo a3 pro");
    mocks.collectLiveResultsStagedAdmitted.mockImplementation(async () => {
      const answer = { products: [OPPO] };
      return { final: Promise.resolve(answer), converged: Promise.resolve(answer) };
    });
    mocks.resolveStored.mockResolvedValue(null);

    const resolved = await resolveProductIdentity("lenovo-gillette-256gb");
    expect(resolved).not.toBeNull();
    // No compatible live group, so the page keeps its own identity (empty
    // offer table) instead of painting the oppo card under a lenovo URL.
    expect(resolved!.productId).toBe("lenovo-gillette-256gb");
    expect(resolved!.offers).toHaveLength(0);
  });

  it("keeps the requested id on a compatible live group instead of the group's id", async () => {
    mocks.readPdpSource.mockResolvedValue("apple year");
    mocks.collectLiveResultsStagedAdmitted.mockImplementation(async () => {
      const answer = {
        products: [
          product("apple-year-512gb-console", "Apple Year 512GB Console"),
        ],
      };
      return { final: Promise.resolve(answer), converged: Promise.resolve(answer) };
    });
    mocks.resolveStored.mockResolvedValue(null);

    const resolved = await resolveProductIdentity("apple-year-512gb");
    expect(resolved).not.toBeNull();
    expect(resolved!.productId).toBe("apple-year-512gb");
    expect(resolved!.offers.map((offer) => offer.merchant)).toEqual(["Eureka"]);
  });

  it("keeps the legacy alias resolution when there is no recorded source query", async () => {
    // A shared link (no sitemap hint) to a legacy 512Phone slug still lands on
    // the compatible 512 GB group — the pre-REEA-1277 behaviour.
    mocks.readPdpSource.mockResolvedValue(null);
    mocks.collectLiveResultsStagedAdmitted.mockImplementation(async () => {
      const answer = {
        products: [product("samsung-galaxy-z-fold7-512gb", "Samsung Galaxy Z Fold7 512GB")],
      };
      return { final: Promise.resolve(answer), converged: Promise.resolve(answer) };
    });
    mocks.resolveStored.mockResolvedValue(null);

    const resolved = await resolveProductIdentity("samsung-galaxy-z-fold7-5g-512phone-black");
    expect(resolved!.productId).toBe("samsung-galaxy-z-fold7-512gb");
  });
});
