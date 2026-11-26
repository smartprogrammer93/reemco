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

// REEA-1211 — the check now runs the PDP's own staged collection; feed it one
// answering product and one that answers nothing. The stored-observation
// branch has its own pins (reea1211-sitemap-liveness.test.ts).
const mocks = vi.hoisted(() => ({ startStaged: vi.fn(), findLastCompleted: vi.fn() }));

vi.mock("@/lib/collect/runner", () => ({
  startProductCollectionStaged: mocks.startStaged,
}));

vi.mock("@/lib/collect/store", () => ({
  findLastCompleted: mocks.findLastCompleted,
}));

mocks.findLastCompleted.mockResolvedValue(undefined);
mocks.startStaged.mockImplementation(async (product: { productId: string }) => ({
  jobId: `job-${product.productId}`,
  firstStage: Promise.resolve({
    offers: product.productId.includes("bose")
      ? []
      : [{ merchant: "Xcite", price: 1, currency: "KWD", url: "https://xcite.example/p" }],
  }),
  finalStage: Promise.resolve({}),
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
