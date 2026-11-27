/**
 * REEA-1269 (Bet 1b) — /sitemap.xml advertises the collected inventory.
 *
 * The measured defect on `251cc9e9`: 6 product URLs, 18 `/results?q=` URLs and
 * 4 static pages — the long tail the live fan-out already collects was never
 * indexable, and the iPhone key advertised was the catalog seed rather than
 * the shelf's canonical key.
 *
 * These pins are the route-level acceptance criteria:
 *  S-1  >=200 product URLs, absolute HTTPS on the production host only;
 *  S-2  one canonical key per SKU (a live merge key folds onto its catalog
 *       identity, never both);
 *  S-3  no `/results?q=` URL counts toward the product target.
 *
 * The fold itself is pinned in lib/reea1269-sitemap-products.test.ts; this
 * suite proves the route wiring (dedupe, canonical fold, cap, origin).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenSnapshot } from "@/lib/collect/last-seen";
import { DEFAULT_SITE_ORIGIN } from "@/lib/site-origin";

const mocks = vi.hoisted(() => ({
  readSnapshots: vi.fn(),
  startStaged: vi.fn(),
  findLastCompleted: vi.fn(),
}));

vi.mock("@/lib/collect/last-seen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collect/last-seen")>();
  return { ...actual, readLatestSeenSnapshots: mocks.readSnapshots };
});

vi.mock("@/lib/collect/runner", () => ({
  startProductCollectionStaged: mocks.startStaged,
}));

vi.mock("@/lib/collect/store", () => ({
  findLastCompleted: mocks.findLastCompleted,
}));

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function hit(title: string, url: string, collectedAt = iso(30 * 60 * 1000)) {
  return {
    title,
    merchant: "Xcite",
    price: 100,
    currency: "KWD",
    url,
    inStock: true,
    country: "KW" as const,
    collectedAt,
  };
}

function snapshot(query: string, hits: unknown[]): SeenSnapshot {
  return {
    query,
    merchant: "Xcite",
    collectedAt: iso(30 * 60 * 1000),
    hits,
    days: [],
  } as unknown as SeenSnapshot;
}

/** 30 queries x 8 distinct SKUs = 240 collected products. */
function collectedInventory(): SeenSnapshot[] {
  const snapshots: SeenSnapshot[] = [];
  for (let q = 0; q < 30; q++) {
    const hits = [];
    for (let p = 0; p < 8; p++) {
      const title = `Acme Gadget${q} Model${p} 256GB`;
      hits.push(hit(title, `https://www.xcite.com/acme-gadget${q}-model${p}-256gb/p`));
    }
    snapshots.push(snapshot(`Acme Gadget${q}`, hits));
  }
  // The measured duplicate-key case: the same iPhone SKU under its live merge
  // key and its catalog identity must appear once, as the catalog identity.
  snapshots.push(
    snapshot("iphone 17 pro", [
      hit("Apple iPhone 17 Pro 256GB Cosmic Orange", "https://www.xcite.com/apple-iphone-17-pro-256gb/p"),
    ]),
  );
  return snapshots;
}

async function sitemapEntries() {
  vi.resetModules();
  const { default: sitemap } = await import("@/app/sitemap");
  return sitemap();
}

beforeEach(() => {
  mocks.readSnapshots.mockReset();
  mocks.startStaged.mockReset();
  mocks.findLastCompleted.mockReset();
  mocks.findLastCompleted.mockResolvedValue(undefined);
  mocks.startStaged.mockImplementation(async (product: { productId: string }) => ({
    jobId: `job-${product.productId}`,
    firstStage: Promise.resolve({
      offers: [{ merchant: "Xcite", price: 1, currency: "KWD", url: "https://xcite.example/p" }],
    }),
    finalStage: Promise.resolve({}),
  }));
  mocks.readSnapshots.mockResolvedValue(collectedInventory());
});

describe("REEA-1269 — sitemap lists the collected inventory", () => {
  it("lists >=200 product URLs on the production host, one canonical key each", async () => {
    const entries = await sitemapEntries();
    const productUrls = entries
      .map((entry) => entry.url)
      .filter((url) => new URL(url).pathname.startsWith("/product/"));
    const resultUrls = entries
      .map((entry) => entry.url)
      .filter((url) => new URL(url).pathname === "/results");

    expect(productUrls.length).toBeGreaterThanOrEqual(200);
    // S-3 — the /results set is kept separately and capped, never counted.
    expect(resultUrls.length).toBeLessThanOrEqual(20);
    for (const url of entries.map((entry) => entry.url)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.origin).toBe(DEFAULT_SITE_ORIGIN);
    }
    const paths = productUrls.map((url) => decodeURIComponent(new URL(url).pathname));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists the catalog identity for a SKU that also has a live merge key", async () => {
    const entries = await sitemapEntries();
    const paths = entries
      .map((entry) => new URL(entry.url).pathname)
      .filter((path) => path.startsWith("/product/"));
    expect(paths).toContain("/product/iphone-17-pro");
    expect(paths).not.toContain("/product/apple-iphone17-pro-256gb");
  });

  it("degrades to the catalog-verified seeds when the observation store is empty", async () => {
    mocks.readSnapshots.mockResolvedValue([]);
    const entries = await sitemapEntries();
    const paths = entries
      .map((entry) => new URL(entry.url).pathname)
      .filter((path) => path.startsWith("/product/"));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThan(200);
    expect(paths).toContain("/product/iphone-17-pro");
  });
});
