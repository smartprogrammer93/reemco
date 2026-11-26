/**
 * REEA-1211 — a catalog PDP paints its last verified observation at first
 * byte when the live lane cannot answer.
 *
 * The defect: `/product/keychron-v3-max` (listed in `/sitemap.xml`) served
 * `<div class="rc-offers-table" aria-busy="true">` and zero `rc-offer-row` in
 * EN and AR, because the catalog seed carries no collectedAt and its only
 * listing — an amazon.eg search URL — answered `HTTP 503`.
 *
 * These pins exercise the real page module (server component called directly,
 * request-time reads mocked) so the regression cannot land silently:
 *  - the seeded, stamped observation reaches BOTH the fan-out (so this run
 *    re-checks the verified listing URL, not the stale search URL) and the
 *    ProductHero payload the first paint renders;
 *  - the seed never overrides a fresher shelf answer, and never invents a row
 *    when the store has nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";
import ProductHero from "@/components/ProductHero";

const mocks = vi.hoisted(() => ({
  startStaged: vi.fn(),
  resolveIdentity: vi.fn(),
  findLastCompleted: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/collect/runner", () => ({
  startProductCollectionStaged: mocks.startStaged,
}));

vi.mock("@/lib/product-identity", () => ({
  resolveProductIdentity: mocks.resolveIdentity,
}));

vi.mock("@/lib/collect/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collect/store")>();
  return { ...actual, findLastCompleted: mocks.findLastCompleted };
});

vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    mocks.afterTasks.push(task);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

import ProductPage from "./product/[productId]/page";

const CATALOG_OFFER = {
  merchant: "Amazon.eg (ships to KW)",
  price: 33.5,
  currency: "KWD",
  url: "https://www.amazon.eg/s?k=Keychron%20V3%20Max",
  inStock: true,
};

const observedAt = new Date(Date.now() - 55 * 60 * 1000).toISOString();

const OBSERVED_OFFER = {
  merchant: "Amazon.eg (ships to KW)",
  domain: "amazon.eg",
  price: 3698.91,
  currency: "EGP",
  url: "https://www.amazon.eg/dp/B0DPWX3WTL",
  inStock: true,
  collectedAt: observedAt,
  collectedAtEpochMs: Date.parse(observedAt),
  method: "live" as const,
};

function catalogProduct(offers: NormalizedProduct["offers"] = [CATALOG_OFFER]): NormalizedProduct {
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

function completedJob(offers: CollectJob["offers"]): CollectJob {
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

type HeroElement = { props: { product: NormalizedProduct; firstStage?: Promise<CollectJob | null> } };

/** Walk the returned element tree down to the ProductHero element. */
function findHero(node: unknown): HeroElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHero(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === ProductHero) return el as unknown as HeroElement;
  return el.props ? findHero(el.props.children) : null;
}

function renderPage() {
  return ProductPage({
    params: Promise.resolve({ productId: "keychron-v3-max" }),
    searchParams: Promise.resolve({}),
  } as unknown as Parameters<typeof ProductPage>[0]);
}

beforeEach(() => {
  mocks.afterTasks.length = 0;
  mocks.startStaged.mockReset();
  mocks.resolveIdentity.mockReset();
  mocks.findLastCompleted.mockReset();
  mocks.resolveIdentity.mockResolvedValue(catalogProduct());
  mocks.startStaged.mockResolvedValue({
    jobId: "job-reea1211",
    firstStage: Promise.resolve(completedJob([])),
    finalStage: Promise.resolve(completedJob([])),
  });
  delete process.env.STATIC_EXPORT;
});

describe("REEA-1211 — catalog PDP seeds the last verified observation", () => {
  it("paints the stored observation and re-checks its verified listing URL", async () => {
    mocks.findLastCompleted.mockResolvedValue(completedJob([OBSERVED_OFFER]));

    const el = await renderPage();

    // The fan-out must target the listing a real run confirmed (/dp/...), not
    // the stale catalog search URL — otherwise the re-check keeps failing.
    const stagedArg = mocks.startStaged.mock.calls[0][0] as NormalizedProduct;
    expect(stagedArg.offers).toHaveLength(1);
    expect(stagedArg.offers[0].url).toBe(OBSERVED_OFFER.url);
    expect(stagedArg.offers[0].collectedAt).toBe(OBSERVED_OFFER.collectedAt);

    // And the first paint's payload carries that stamped row, so the served
    // HTML renders an offer row instead of an empty table.
    const hero = findHero(el);
    expect(hero).not.toBeNull();
    expect(hero?.props.product.offers).toHaveLength(1);
    expect(hero?.props.product.offers[0].collectedAt).toBe(OBSERVED_OFFER.collectedAt);
    expect((hero?.props.product.offers[0] as unknown as { method?: string }).method).toBe("cache");
  });

  it("keeps a fresher shelf answer and does not consult the store", async () => {
    const stamped = { ...CATALOG_OFFER, collectedAt: "2026-11-26T08:10:00.000Z" };
    mocks.resolveIdentity.mockResolvedValue(catalogProduct([stamped]));

    const el = await renderPage();

    expect(mocks.findLastCompleted).not.toHaveBeenCalled();
    const hero = findHero(el);
    expect(hero?.props.product.offers[0].collectedAt).toBe(stamped.collectedAt);
    expect((hero?.props.product.offers[0] as unknown as { method?: string }).method).not.toBe("cache");
  });

  it("leaves the identity untouched when the store has no completed observation", async () => {
    mocks.findLastCompleted.mockResolvedValue(undefined);

    const el = await renderPage();

    const stagedArg = mocks.startStaged.mock.calls[0][0] as NormalizedProduct;
    expect(stagedArg.offers[0].collectedAt).toBeUndefined();
    expect(findHero(el)?.props.product.offers[0].collectedAt).toBeUndefined();
  });
});
