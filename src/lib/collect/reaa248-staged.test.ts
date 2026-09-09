/**
 * REEA-248 — staged product collection for /product/... renders.
 *
 * Covers the three contract points of startProductCollectionStaged:
 * firstStage lands with the first retailer's answer (the first-paint offer),
 * finalStage always carries a terminal snapshot even when every retailer
 * fails, and a dedupe hit attaches to the in-flight job WITHOUT re-running
 * the scrape fan-out (rate-limit citizenship + AC2 no-double-fetch).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedProduct } from "@/types/product";

const cacheDir = mkdtempSync(join(tmpdir(), "reemco-staged-test-"));
process.env.COLLECT_CACHE_DIR = cacheDir;

// Dynamic imports so the store picks up the temp cache dir.
const { resetStoreForTests } = await import("@/lib/collect/store");
const { startProductCollectionStaged } = await import("@/lib/collect/runner");

function product(productId: string): NormalizedProduct {
  return {
    productId,
    title: "Staged Product",
    brand: "Test",
    offers: [
      { merchant: "Alpha", price: 10, currency: "KWD", url: "https://alpha.example/p/1", inStock: true },
      { merchant: "Beta", price: 12, currency: "KWD", url: "https://beta.example/p/1", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

const okHtml = '<script type="application/ld+json">{"price":"11.5"}</script>';

beforeEach(() => {
  resetStoreForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("startProductCollectionStaged", () => {
  it("firstStage resolves with the first landed retailer offer", async () => {
    const fetchImpl = () => Promise.resolve(new Response(okHtml, { status: 200 }));
    const staged = await startProductCollectionStaged(product("staged-248-first"), { fetchImpl });
    const snap = await staged.firstStage;
    expect(snap.offers.length).toBeGreaterThanOrEqual(1);
    expect(snap.jobId).toBe(staged.jobId);
    // The full run still settles on the terminal snapshot.
    const finalSnap = await staged.finalStage;
    expect(finalSnap.status).toBe("complete");
    expect(finalSnap.offers.length).toBeGreaterThanOrEqual(snap.offers.length);
  });

  it("finalStage carries a terminal snapshot when every retailer fails", async () => {
    const fetchImpl = () => Promise.resolve(new Response("", { status: 500 }));
    const staged = await startProductCollectionStaged(product("staged-248-fail"), { fetchImpl });
    const finalSnap = await staged.finalStage;
    expect(finalSnap.status).toBe("failed");
    // The first stage never hangs on an all-failed run — it settles too.
    const snap = await staged.firstStage;
    expect(snap.jobId).toBe(staged.jobId);
  });

  it("dedupes onto the in-flight job without re-running the scrape", async () => {
    // Never-settling first fetch keeps the first job `collecting` for the
    // duration of the assertion (the runner's own budget bounds it later).
    const firstFetch = vi.fn(
      () => new Promise<Response>(() => {}),
    );
    const staged = await startProductCollectionStaged(product("staged-248-dedup"), {
      fetchImpl: firstFetch,
    });
    // Attach while the first run is still collecting: the second call must
    // reuse the job id and must NOT fan out a second scrape.
    const secondFetch = vi.fn(() => Promise.resolve(new Response(okHtml, { status: 200 })));
    const attached = await startProductCollectionStaged(product("staged-248-dedup"), {
      fetchImpl: secondFetch,
    });
    const snap = await attached.firstStage;
    expect(snap.jobId).toBe(staged.jobId);
    expect(secondFetch).toHaveBeenCalledTimes(0);
  });
});
