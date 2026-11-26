/**
 * REEA-1211 — the dedupe path must honour "first paint waits for a first offer
 * or the run's terminal state".
 *
 * a7236a4 fixed `startProductCollectionStaged` to resolve `firstStage` only on
 * an offer or a terminal snapshot, but a dedupe hit attaches to an already
 * in-flight run through `attachToInflight`, which gave up after the PER-LANE
 * ceiling (4.5 s). A single-listing identity whose lane spends longer than
 * that — the scraper's search fallback alone allows two 8 s attempts, and the
 * runner races the whole scrape against its 10 s budget — therefore resolved
 * the empty intermediate snapshot. On the measured keychron-v3-max that is the
 * empty first paint QA reproduced on five consecutive fetches.
 *
 * This pin drives a run that lands at ~5 s (past the old 4.5 s ceiling) and
 * asserts the attached first paint carries the offer.
 */
import "./test-cache-dir";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";

const {
  resetStoreForTests,
  getJob,
  touchJob,
  getInflightJobId,
} = await import("@/lib/collect/store");
const { startCollection, startProductCollectionStaged } = await import(
  "@/lib/collect/runner"
);

function product(): NormalizedProduct {
  return {
    productId: "reea1211-attach",
    title: "Keychron V3 Max QMK Wireless Mechanical Keyboard",
    brand: "Keychron",
    offers: [
      {
        merchant: "Amazon.eg (ships to KW)",
        price: 33.5,
        currency: "KWD",
        url: "https://www.amazon.eg/s?k=Keychron%20V3%20Max",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function landedOffer() {
  const collectedAt = new Date().toISOString();
  return {
    merchant: "Amazon.eg (ships to KW)",
    domain: "amazon.eg",
    price: 3698.91,
    currency: "EGP",
    url: "https://www.amazon.eg/dp/B0DPWX3WTL",
    inStock: true,
    collectedAt,
    collectedAtEpochMs: Date.parse(collectedAt),
    method: "live" as const,
  };
}

beforeEach(() => {
  resetStoreForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("REEA-1211 — a deduped PDP waits for the run's answer, not the per-lane ceiling", () => {
  it("resolves firstStage with the offer when the attached run lands after 4.5s", async () => {
    const p = product();
    // An earlier request owns the in-flight run (dedupe hit).
    await startCollection(p);
    const jobId = await getInflightJobId(p.productId);
    expect(jobId).toBeTruthy();

    const stagedPromise = startProductCollectionStaged(p);
    // Let the attach loop start and poll past the old 4.5 s ceiling.
    await vi.advanceTimersByTimeAsync(5_000);

    // The lane answers at ~5 s: publish the landed offer + terminal state the
    // way the runner does on its final flush.
    const job = (await getJob(jobId as string)) as CollectJob;
    job.offers = [landedOffer()];
    job.status = "complete";
    await touchJob(job);

    await vi.advanceTimersByTimeAsync(500);

    const staged = await stagedPromise;
    const first = await staged.firstStage;
    expect(first.offers).toHaveLength(1);
    expect(first.offers[0].url).toBe("https://www.amazon.eg/dp/B0DPWX3WTL");
  });
});
