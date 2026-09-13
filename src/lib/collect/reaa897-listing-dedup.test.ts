/**
 * REEA-897 — one offer card per unique retailer+SKU on the product page.
 *
 * The defect chain, pinned at both layers:
 *  1. SOURCE (live-search grouping): the per-merchant card fold keyed on the
 *     title-derived listing label, so the same listing URL reaching the group
 *     under two title spellings survived as two rows with one purchasable
 *     unit. The product page's collect fan-out then scraped the SAME listing
 *     twice and stacked two identical offers — both badged Best price, chips
 *     reading "Wibi x2" (QA repro, stamp c93006c3bcc8).
 *  2. RUNNER chokepoint: subtask/append dedupe by merchant+URL so a
 *     duplicated product-offer row can never fan out into two scrapes of one
 *     listing, and the retailer-search fallback re-discovering the same
 *     canonical listing from two distinct seed URLs cannot stack either.
 *  3. RETRY sibling: a single-listing retry must not wipe the merchant's
 *     OTHER distinct-SKU rows (the old replace-by-merchant filter did).
 *
 * Live-data fidelity note: every row comes from the group's own fetched hits
 * — the dedupe folds only listings that are literally the same URL, so
 * distinct retailer SKUs (plain vs "Japanese Version") keep their rows.
 */
import "./test-cache-dir";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchHit } from "@/lib/collect/live-search";
import { groupHits } from "@/lib/collect/live-search";
import type { NormalizedProduct } from "@/types/product";

// Store isolation for the runner pins (same convention as collect.test.ts).
process.env.COLLECT_CACHE_DIR = mkdtempSync(join(tmpdir(), "reemco-reea897-test-"));
const { resetStoreForTests } = await import("@/lib/collect/store");
const { runCollection, startCollection, retryRetailer, uniqueListings } = await import(
  "@/lib/collect/runner"
);
const fallback = await import("@/lib/collect/search-fallback");

vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "Apple iPhone 17 Pro Max 512GB Silver Dual eSIM",
    merchant: "Wibi",
    price: 409.9,
    currency: "KWD",
    url: "https://wibi.com.kw/products/apple-iphone-17-pro-max-512gb-silver-dual-e-sim",
    inStock: true,
    country: "KW",
    ...over,
  };
}

function product(offers: NormalizedProduct["offers"]): NormalizedProduct {
  return {
    productId: "reea897-test-product",
    title: "Apple iPhone 17 Pro Max",
    brand: "Apple",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

const okHtml = '<script type="application/ld+json">{"price":"11.5"}</script>';
const fetchOk = (): Promise<Response> =>
  Promise.resolve(new Response(okHtml, { status: 200 }));

beforeEach(() => {
  resetStoreForTests();
});

describe("REEA-897 source: one row per unique retailer+SKU in the grouped card", () => {
  it("folds the same merchant+URL arriving under two title spellings into ONE row", () => {
    const wibiListing = "https://wibi.com.kw/products/apple-iphone-17-pro-max-512gb-silver-dual-e-sim";
    const products = groupHits("iphone 17 pro max", [
      hit({
        title: "Apple iPhone 17 Pro Max 512GB Silver",
        price: 409.9,
        url: wibiListing,
      }),
      // Same listing under a second spelling that carries a visible
      // qualifier — the deployed duplicate: same store, same URL, two rows
      // (two cards, both badged Best price) because the old fold keyed on
      // the title-derived label alone.
      hit({
        title: "Apple iPhone 17 Pro Max 512GB Silver Japanese Version",
        price: 415,
        url: wibiListing,
      }),
      hit({
        title: "Apple iPhone 17 Pro Max 256GB Silver",
        merchant: "Blink",
        price: 364.9,
        url: "https://blink.com.kw/products/apple-iphone-17-pro-max",
      }),
    ]);
    // The Blink hit is a 256 GB card of its own; the Wibi card must carry
    // exactly ONE row for the duplicated listing.
    const wibiCard = products.find((p) => p.offers.some((o) => o.merchant === "Wibi"));
    if (!wibiCard) throw new Error("no Wibi card");
    const wibiRows = wibiCard.offers.filter((o) => o.merchant === "Wibi");
    expect(wibiRows).toHaveLength(1);
    // Sorted-first (cheapest effective) row wins the fold.
    expect(wibiRows[0]?.price).toBe(409.9);
    expect(wibiCard.offers).toHaveLength(1);
  });

  it("still keeps REEA-486 labeled distinct-SKU rows (plain vs Japanese Version)", () => {
    const products = groupHits("iphone 17 pro max", [
      hit({
        title: "Apple iPhone 17 Pro Max 256GB Silver",
        merchant: "Zayoom",
        price: 399.9,
        url: "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver",
      }),
      hit({
        title: "Apple iPhone 17 Pro Max 256GB Silver Japanese Version",
        merchant: "Zayoom",
        price: 379.9,
        url: "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver-japanese",
      }),
    ]);
    // Distinct listing URLs are distinct purchasable SKUs — both rows stay.
    const zayoom = products.find((p) => p.offers.some((o) => o.merchant === "Zayoom"));
    expect(zayoom?.offers.filter((o) => o.merchant === "Zayoom")).toHaveLength(2);
  });

  it("still folds a merchant's unlabeled distinct listings to its best row (REEA-192)", () => {
    const products = groupHits("iphone 17 pro max", [
      hit({ title: "Apple iPhone 17 Pro Max 512GB", merchant: "Blink", price: 369, url: "https://blink.com.kw/products/a" }),
      hit({ title: "Apple iPhone 17 Pro Max 256GB", merchant: "Blink", price: 364.9, url: "https://blink.com.kw/products/b" }),
    ]);
    expect(products[0].offers.filter((o) => o.merchant === "Blink")).toHaveLength(1);
    expect(products[0].offers[0]?.price).toBe(364.9);
  });
});

describe("REEA-897 runner chokepoint", () => {
  const wibiListing = "https://wibi.com.kw/products/apple-iphone-17-pro-max-512gb-silver-dual-e-sim";
  const duplicated = product([
    {
      merchant: "Wibi",
      price: 409.9,
      currency: "KWD",
      url: wibiListing,
      inStock: true,
    },
    {
      merchant: "Wibi",
      price: 415,
      currency: "KWD",
      url: wibiListing,
      inStock: true,
    },
    {
      merchant: "Blink",
      price: 369,
      currency: "KWD",
      url: "https://blink.com.kw/products/apple-iphone-17-pro-max",
      inStock: true,
    },
  ]);

  it("uniqueListings keeps the first occurrence per retailer+URL", () => {
    const uniq = uniqueListings(duplicated.offers);
    expect(uniq).toHaveLength(2);
    expect(uniq.map((o) => o.price)).toEqual([409.9, 369]);
  });

  it("startCollection builds ONE subtask per unique listing (no Wibi x2 chips)", async () => {
    const { job } = await startCollection(duplicated);
    expect(job.subtasks.map((s) => s.retailer)).toEqual(["Wibi", "Blink"]);
  });

  it("runCollection scrapes each listing once and stacks no duplicate offer rows", async () => {
    const urls: string[] = [];
    const spy = (url: string): Promise<Response> => {
      urls.push(url);
      return fetchOk();
    };
    const { job } = await startCollection(duplicated, { force: true });
    const done = await runCollection(job, duplicated, { fetchImpl: spy, now: 1_000_000 });
    // The duplicated Wibi row is scraped exactly once (rate-limit citizenship).
    expect(urls.filter((u) => u.includes("wibi.com.kw"))).toHaveLength(1);
    expect(done.offers.filter((o) => o.merchant === "Wibi")).toHaveLength(1);
    // No merchant+URL pair appears twice in the served offers.
    const keys = done.offers.map((o) => `${o.merchant}|${o.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the append guard folds a fallback-re-discovered canonical listing from two distinct seed URLs", async () => {
    // Two DISTINCT seed URLs for the same merchant; direct fetches fail and
    // the retailer-search fallback re-discovers the SAME canonical URL —
    // exactly one offer may render for that listing.
    const seeds = product([
      { merchant: "Wibi", price: 409.9, currency: "KWD", url: "https://wibi.com.kw/products/old-seed-a", inStock: true },
      { merchant: "Wibi", price: 409.9, currency: "KWD", url: "https://wibi.com.kw/products/old-seed-b", inStock: true },
    ]);
    vi.spyOn(fallback, "searchRetailerFallback").mockImplementation(async () => ({
      url: wibiListing,
      price: 409.9,
      currency: "KWD",
      inStock: true,
    }));
    const dead = (): Promise<Response> => Promise.reject(new Error("HTTP 500"));
    const { job } = await startCollection(seeds, { force: true });
    const done = await runCollection(job, seeds, { fetchImpl: dead, now: 1_000_000 });
    expect(done.offers.filter((o) => o.merchant === "Wibi")).toHaveLength(1);
    expect(done.offers[0]?.url).toBe(wibiListing);
  });

  it("retrying one listing never wipes the merchant's other distinct-SKU row", async () => {
    let seedAFails = true;
    const flaky = (url: string): Promise<Response> => {
      if (url.includes("old-seed-a") && seedAFails) return Promise.reject(new Error("HTTP 503"));
      return fetchOk();
    };
    const twoListings = product([
      { merchant: "Wibi", price: 409.9, currency: "KWD", url: "https://wibi.com.kw/products/old-seed-a", inStock: true },
      { merchant: "Wibi", price: 415, currency: "KWD", url: "https://wibi.com.kw/products/old-seed-b", inStock: true },
    ]);
    const { job } = await startCollection(twoListings, { force: true });
    const first = await runCollection(job, twoListings, { fetchImpl: flaky, now: 1_000_000 });
    expect(first.status).toBe("complete");
    expect(first.offers.filter((o) => o.url.includes("old-seed-b"))).toHaveLength(1);

    seedAFails = false;
    const retried = await retryRetailer(first, twoListings, "Wibi", {
      fetchImpl: flaky,
      now: 1_000_000,
    });
    if (!retried) throw new Error("retry returned undefined");
    // Both distinct listings render exactly once after the retry.
    expect(retried.offers.filter((o) => o.url.includes("old-seed-a"))).toHaveLength(1);
    expect(retried.offers.filter((o) => o.url.includes("old-seed-b"))).toHaveLength(1);
  });
});
