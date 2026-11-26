/**
 * REEA-1211 — sitemap/PDP agreement on the keychron-v3-max defect.
 *
 * Measured on bee33ea: `/sitemap.xml` listed `/product/keychron-v3-max` while
 * that page served `<div class="rc-offers-table" aria-busy="true">` with zero
 * offer rows for 5 consecutive fetches in EN and AR. The identity's only
 * listing is an amazon.eg search URL that answers HTTP 503 for long stretches,
 * so the sitemap's live check (which the PDP never granted the same budget to)
 * could succeed at crawl time while the PDP painted an empty table.
 *
 * The amended item-2 criterion is "0 of the sitemap product URLs may be
 * empty". These pins fix the predicate: a URL is advertised only when the page
 * would paint a row from EITHER the stored verified observation the page now
 * seeds, OR a live re-check inside the PDP's own first-paint budget. A check
 * that overruns is a "no" (fail-closed), so the crawler-facing answer can never
 * promise more than the page delivers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinBudget } from "@/app/sitemap";

const mocks = vi.hoisted(() => ({
  scrapeOffer: vi.fn(),
  lastVerified: vi.fn(),
}));

vi.mock("@/lib/collect/scraper", () => ({ scrapeOffer: mocks.scrapeOffer }));
vi.mock("@/lib/collect/last-observation", () => ({
  lastVerifiedObservation: mocks.lastVerified,
  seedCatalogPageWithLastObservation: async (p: unknown) => p,
}));

/** Fresh module state per case: the product memo is module-level. */
async function sitemapUrls(): Promise<string[]> {
  vi.resetModules();
  const { default: sitemap } = await import("@/app/sitemap");
  return (await sitemap()).map((entry) => entry.url);
}

beforeEach(() => {
  mocks.scrapeOffer.mockReset();
  mocks.lastVerified.mockReset();
});

describe("REEA-1211 — the sitemap advertises only URLs whose page paints a row", () => {
  it("lists an identity whose stored observation the page can paint, even while its live lane is down", async () => {
    // keychron-v3-max: amazon.eg answers nothing right now, but the store
    // holds a completed observation the PDP seeds and paints (labelled with
    // its own collectedAt).
    mocks.lastVerified.mockImplementation(async (productId: string) =>
      productId === "keychron-v3-max"
        ? [
            {
              merchant: "Amazon.eg (ships to KW)",
              price: 3698.91,
              currency: "EGP",
              url: "https://www.amazon.eg/dp/B0DPWX3WTL",
              inStock: true,
              collectedAt: "2026-11-26T08:00:05.000Z",
            },
          ]
        : null,
    );
    mocks.scrapeOffer.mockResolvedValue({ offers: [], timedOut: false });

    const urls = await sitemapUrls();
    expect(urls.some((u) => u.endsWith("/product/keychron-v3-max"))).toBe(true);
  });

  it("omits an identity with neither a stored observation nor a live answer", async () => {
    mocks.lastVerified.mockResolvedValue(null);
    mocks.scrapeOffer.mockImplementation(async (offer: { titleQuery?: string }) =>
      (offer.titleQuery ?? "").toLowerCase().includes("bose")
        ? { offers: [], timedOut: false }
        : {
            offers: [{ merchant: "Xcite", price: 1, currency: "KWD", url: "https://xcite.example/p" }],
            timedOut: false,
          },
    );

    const urls = await sitemapUrls();
    expect(urls.some((u) => u.endsWith("/product/bose-qc-ultra"))).toBe(false);
    expect(urls.some((u) => u.endsWith("/product/iphone-17-pro"))).toBe(true);
  });

  it("advertises no product URL when nothing answers and nothing is stored", async () => {
    mocks.lastVerified.mockResolvedValue(null);
    mocks.scrapeOffer.mockResolvedValue({ offers: [], timedOut: false });

    const urls = await sitemapUrls();
    expect(urls.filter((u) => u.includes("/product/"))).toEqual([]);
  });

  it("treats a live check that overruns the PDP budget as a no (fail-closed)", async () => {
    // A check that never settles must not hold the crawler-facing response
    // past the PDP's own first-paint budget, and must not advertise the URL.
    const verdict = await withinBudget(new Promise<boolean>(() => {}), false, 25);
    expect(verdict).toBe(false);
  });
});
