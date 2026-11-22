/**
 * REEA-1063 — process-wide in-flight cap for live collection runs.
 *
 * The per-caller rate limit bounds how often ONE client starts a collection;
 * it does not bound how many distinct products fan out at once. These pins
 * prove the admission guard: at most MAX_INFLIGHT_COLLECTIONS run bodies are
 * admitted concurrently, extra runs queue (not reject), and every slot is
 * released so a completed batch cannot leak capacity. The constants pin also
 * keeps the bounded admission wait inside the stale-collecting reap window.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { NormalizedProduct } from "@/types/product";

const cacheDir = mkdtempSync(join(tmpdir(), "reemco-inflight-test-"));
process.env.COLLECT_CACHE_DIR = cacheDir;

const { startCollection, runCollection } = await import("@/lib/collect/runner");
const { resetStoreForTests } = await import("@/lib/collect/store");
const {
  MAX_INFLIGHT_COLLECTIONS,
  ADMISSION_WAIT_MS,
  inflightCollectionCount,
  resetCollectionInflightForTests,
} = await import("@/lib/collect/inflight");
const { INFLIGHT_STALE_MS } = await import("@/lib/collect/types");

const okHtml = '<script type="application/ld+json">{"price":"11.5"}</script>';

function product(productId: string): NormalizedProduct {
  return {
    productId,
    title: "Inflight Probe Product",
    brand: "Test",
    offers: [
      {
        merchant: "Alpha",
        price: 10,
        currency: "KWD",
        url: "https://alpha.example/p/1",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

beforeEach(() => {
  resetStoreForTests();
  resetCollectionInflightForTests();
});

describe("REEA-1063 collection admission control", () => {
  it("pins a positive per-process cap and a bounded admission wait", () => {
    expect(Number.isInteger(MAX_INFLIGHT_COLLECTIONS)).toBe(true);
    expect(MAX_INFLIGHT_COLLECTIONS).toBeGreaterThanOrEqual(1);
    // A queued run must start before the stale-collecting reap window, or a
    // repeat click could reap it as dead while it is still waiting.
    expect(ADMISSION_WAIT_MS).toBeLessThan(INFLIGHT_STALE_MS);
  });

  it("admits at most the cap at once, queues the rest, and releases every slot", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const blockedFetch = async (): Promise<Response> => {
      await gate;
      return new Response(okHtml, { status: 200 });
    };

    const runs: Array<Promise<unknown>> = [];
    for (let i = 0; i < MAX_INFLIGHT_COLLECTIONS + 1; i += 1) {
      const p = product(`cap-product-${i}`);
      const { job } = await startCollection(p);
      runs.push(runCollection(job, p, { fetchImpl: blockedFetch }));
    }

    // Let the admitted runs reach their blocked retailer fetch; the extra run
    // is waiting for a slot, not fanning out.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inflightCollectionCount()).toBe(MAX_INFLIGHT_COLLECTIONS);

    openGate();
    await Promise.all(runs);
    // Every slot released — a later batch can be admitted in full.
    expect(inflightCollectionCount()).toBe(0);
  });
});
