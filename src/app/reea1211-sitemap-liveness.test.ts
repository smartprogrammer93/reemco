/**
 * REEA-1211 — sitemap/PDP agreement on the keychron-v3-max defect.
 *
 * Measured on bee33ea: `/sitemap.xml` listed `/product/keychron-v3-max` while
 * that page served `<div class="rc-offers-table" aria-busy="true">` with zero
 * offer rows for 5 consecutive fetches in EN and AR. The identity's only
 * listing is an amazon.eg search URL that answers HTTP 503 for long stretches,
 * so a crawl-time check could succeed while the page's own run answered 503
 * and painted nothing.
 *
 * The amended item-2 criterion is "0 of the sitemap product URLs may be
 * empty". These pins fix the predicate: a URL is advertised only when the page
 * would paint a row from EITHER a FRESH stored observation (which the page
 * seeds), OR the PDP's own staged collection landing an offer (which also
 * writes the stored observation the next page can seed). A check that overruns
 * its budget is a "no" (fail-closed), and a stale-only observation is a "no"
 * too (REEA-1168 AC-7: no price claim from a row older than the window), so
 * the crawler-facing answer can never promise more than the page delivers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinBudget } from "@/app/sitemap";

const mocks = vi.hoisted(() => ({
  startStaged: vi.fn(),
  findLastCompleted: vi.fn(),
}));

vi.mock("@/lib/collect/runner", () => ({
  startProductCollectionStaged: mocks.startStaged,
}));

// Only the store is stubbed: the real freshness filter in
// lib/collect/last-observation is exercised, not mocked away.
vi.mock("@/lib/collect/store", () => ({
  findLastCompleted: mocks.findLastCompleted,
}));

/** Fresh module state per case: the product memo is module-level. */
async function sitemapUrls(): Promise<string[]> {
  vi.resetModules();
  const { default: sitemap } = await import("@/app/sitemap");
  return (await sitemap()).map((entry) => entry.url);
}

/** A staged-collection handle whose first paint carries (or lacks) an offer. */
function staged(hasOffer: boolean) {
  return {
    jobId: "job-reea1211",
    firstStage: Promise.resolve({
      offers: hasOffer
        ? [
            {
              merchant: "Amazon.eg (ships to KW)",
              price: 3698.91,
              currency: "EGP",
              url: "https://www.amazon.eg/dp/B0DPWX3WTL",
            },
          ]
        : [],
    }),
    finalStage: Promise.resolve({}),
  };
}

function completedJob(observedAt: string) {
  return {
    jobId: "job-reea1211",
    productId: "keychron-v3-max",
    status: "complete",
    mode: "live",
    startedAt: observedAt,
    finishedAt: observedAt,
    subtasks: [],
    offers: [
      {
        merchant: "Amazon.eg (ships to KW)",
        domain: "amazon.eg",
        price: 3698.91,
        currency: "EGP",
        url: "https://www.amazon.eg/dp/B0DPWX3WTL",
        inStock: true,
        collectedAt: observedAt,
        collectedAtEpochMs: Date.parse(observedAt),
        method: "live",
      },
    ],
  };
}

const fresh = () => new Date(Date.now() - 55 * 60 * 1000).toISOString();
const stale = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  mocks.startStaged.mockReset();
  mocks.findLastCompleted.mockReset();
});

describe("REEA-1211 — the sitemap advertises only URLs whose page paints a row", () => {
  it("lists an identity whose fresh stored observation the page can paint, even while its live lane is down", async () => {
    // keychron-v3-max: amazon.eg answers nothing right now, but the store
    // holds a fresh completed observation the PDP seeds and paints (labelled
    // with its own collectedAt).
    mocks.findLastCompleted.mockImplementation(async (productId: string) =>
      productId === "keychron-v3-max" ? completedJob(fresh()) : undefined,
    );
    mocks.startStaged.mockResolvedValue(staged(false));

    const urls = await sitemapUrls();
    expect(urls.some((u) => u.endsWith("/product/keychron-v3-max"))).toBe(true);
    // The stored observation answered, so no retailer fetch was spent on it.
    expect(mocks.startStaged).not.toHaveBeenCalledWith(
      expect.objectContaining({ productId: "keychron-v3-max" }),
    );
  });

  it("lists an identity only when the PDP's own staged run lands an offer", async () => {
    mocks.findLastCompleted.mockResolvedValue(undefined);
    mocks.startStaged.mockImplementation(async (product: { productId: string }) =>
      staged(!product.productId.includes("bose")),
    );

    const urls = await sitemapUrls();
    expect(urls.some((u) => u.endsWith("/product/bose-qc-ultra"))).toBe(false);
    expect(urls.some((u) => u.endsWith("/product/iphone-17-pro"))).toBe(true);
    // The check is the page's own path, not a lookalike scrape.
    expect(mocks.startStaged).toHaveBeenCalled();
  });

  it("advertises no product URL when nothing answers and nothing is stored", async () => {
    mocks.findLastCompleted.mockResolvedValue(undefined);
    mocks.startStaged.mockResolvedValue(staged(false));

    const urls = await sitemapUrls();
    expect(urls.filter((u) => u.includes("/product/"))).toEqual([]);
  });

  it("does not advertise a URL whose only stored observation is stale (REEA-1168 AC-7)", async () => {
    // A row older than the site freshness window emits no price claim, so it
    // must not be advertised as a structured-data product page either.
    mocks.findLastCompleted.mockImplementation(async (productId: string) =>
      productId === "keychron-v3-max" ? completedJob(stale()) : undefined,
    );
    mocks.startStaged.mockResolvedValue(staged(false));

    const urls = await sitemapUrls();
    expect(urls.filter((u) => u.includes("/product/"))).toEqual([]);
  });

  it("treats a check that overruns the PDP budget as a no (fail-closed)", async () => {
    // A check that never settles must not hold the crawler-facing response
    // past the PDP's own first-paint budget, and must not advertise the URL.
    const verdict = await withinBudget(new Promise<boolean>(() => {}), false, 25);
    expect(verdict).toBe(false);
  });
});
