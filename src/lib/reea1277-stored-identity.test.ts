/**
 * REEA-1277 — a listed live-only key resolves to its OWN product from the
 * stored observation that minted it.
 *
 * The measured defect on `d9e411c9`: `/sitemap.xml` listed 287 product URLs,
 * every canonical tag self-aligned, but a cold PDP visit painted another
 * product's offer set (7/24 QA sample): `/product/sandisk-extreme-…` served an
 * OPPO A3 Pro, `/product/lenovo-gillette-256gb` served an Asus keyboard. The
 * sitemap fold minted those keys from the stored live rounds
 * (lib/sitemap-products.ts); when today's live run no longer carried the exact
 * id, `resolveProductIdentity` fell through to a canonical neighbour and the
 * listed URL advertised someone else's offers — the thin duplicate key S-2
 * forbids.
 *
 * These pins hold the stored-evidence resolver: regroup the stored round with
 * the SAME merge primitive the sitemap fold used, rebuild a tier-2 alias from
 * its day-slot identity, and never throw when the store has no answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenSnapshot } from "@/lib/collect/last-seen";

const mocks = vi.hoisted(() => ({
  readSnapshots: vi.fn(),
}));

vi.mock("@/lib/collect/last-seen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collect/last-seen")>();
  return { ...actual, readLatestSeenSnapshots: mocks.readSnapshots };
});

const { resolveStoredProductIdentity } = await import("@/lib/pdp-stored-identity");

const NOW = Date.parse("2026-11-28T03:00:00Z");
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

function snapshot(query: string, merchant: string, hits: unknown[], days: unknown[] = []): SeenSnapshot {
  return {
    query,
    merchant,
    collectedAt: iso(60 * 60 * 1000),
    hits,
    days,
  } as unknown as SeenSnapshot;
}

beforeEach(() => {
  mocks.readSnapshots.mockReset();
});

describe("REEA-1277 — resolve a listed key from its stored live round", () => {
  it("returns the sandisk card, not the oppo card from the same round", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("oppo a3 pro", "Eureka", [
        hit({
          merchant: "Eureka",
          title: "SanDisk Extreme PRO micro SDXC UHS-I Card Adapter 256GB",
          url: "https://www.eureka.com.kw/products/details/sandisk-extreme-pro-256gb",
          price: 8.9,
        }),
        hit({
          merchant: "Eureka",
          title: "OPPO A3 Pro 5G 256GB",
          url: "https://www.eureka.com.kw/products/details/oppo-a3-pro",
          price: 79.9,
        }),
      ]),
      snapshot("oppo a3 pro", "Xcite", [
        hit({
          merchant: "Xcite",
          title: "OPPO A3 Pro 5G 256GB",
          url: "https://www.xcite.com/oppo-a3-pro-256gb/p",
          price: 75.9,
        }),
      ]),
    ]);

    const resolved = await resolveStoredProductIdentity(
      "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
      ["oppo a3 pro"],
      NOW,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.productId).toBe("sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb");
    expect(resolved!.offers.map((offer) => offer.merchant)).toEqual(["Eureka"]);
    expect(resolved!.title).toContain("SanDisk");
  });

  it("rebuilds a tier-2 alias from its stored day-slot identity", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("bose", "Wibi", [], [
        {
          observedAt: iso(2 * 60 * 60 * 1000),
          offers: [
            {
              price: 89.9,
              currency: "KWD",
              country: "KW",
              identity: {
                fields: {
                  brand: "bose",
                  modelLine: "ultra open type c chilled lilac",
                  platform: "",
                  storage: "",
                  color: "",
                  grade: "new",
                },
                accessory: false,
              },
            },
          ],
        },
      ]),
    ]);

    const resolved = await resolveStoredProductIdentity(
      "bose-ultra-open-type-c-chilled-lilac",
      ["bose"],
      NOW,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.productId).toBe("bose-ultra-open-type-c-chilled-lilac");
    // The row keeps the merchant and the moment it was observed — never a
    // fabricated "just now".
    expect(resolved!.offers).toHaveLength(1);
    expect(resolved!.offers[0].merchant).toBe("Wibi");
    expect(resolved!.offers[0].collectedAt).toBe(iso(2 * 60 * 60 * 1000));
  });

  it("returns null when the store holds no evidence for the key", async () => {
    mocks.readSnapshots.mockResolvedValue([
      snapshot("oppo a3 pro", "Xcite", [
        hit({ merchant: "Xcite", title: "OPPO A3 Pro 5G 256GB", url: "https://www.xcite.com/oppo-a3-pro-256gb/p" }),
      ]),
    ]);
    await expect(
      resolveStoredProductIdentity("lenovo-gillette-256gb", ["oppo a3 pro"], NOW),
    ).resolves.toBeNull();
  });

  it("never throws when the store read fails", async () => {
    mocks.readSnapshots.mockRejectedValue(new Error("kv down"));
    await expect(
      resolveStoredProductIdentity("sony-wh1000xm5", ["sony"], NOW),
    ).resolves.toBeNull();
  });
});
