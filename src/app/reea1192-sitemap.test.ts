/**
 * REEA-1192 — sitemap honesty: a /product/* URL is advertised only when the
 * page it points at has at least one offer to show.
 *
 * On the served head 11 of 12 listed product URLs rendered 0 offer rows and
 * three printed "All offers · … retailers". The catalog is an identity
 * source, not a price source (REEA-95), so a stale seed must not be listed
 * until a live re-check confirms it.
 */
import { describe, expect, it, vi } from "vitest";

// The check runs the same live listing re-check the PDP runs; this pin feeds
// it one answering product and one that answers nothing.
vi.mock("@/lib/collect/scraper", () => ({
  scrapeOffer: async (offer: { url: string; titleQuery?: string }) => {
    if ((offer.titleQuery ?? "").toLowerCase().includes("bose")) return { offers: [], timedOut: false };
    return {
      offers: [{ merchant: "Xcite", price: 1, currency: "KWD", url: offer.url }],
      timedOut: false,
    };
  },
}));

const { default: sitemap } = await import("@/app/sitemap");

describe("REEA-1192 — sitemap lists only product URLs that render an offer", () => {
  it("omits a catalog identity whose listings answer nothing", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls.some((u) => u.endsWith("/product/bose-qc-ultra"))).toBe(false);
  });

  it("keeps a catalog identity whose listings answer live", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls.some((u) => u.endsWith("/product/iphone-17-pro"))).toBe(true);
  });
});
