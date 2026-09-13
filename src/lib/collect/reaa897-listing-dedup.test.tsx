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
 * REEA-908 spec additions pinned here too: the dedupe key normalizes the
 * listing URL (lowercase host, query string and trailing slash stripped); the
 * append survivor is the CHEAPEST occurrence when prices disagree; the badge
 * rule renders exactly ONE "Best price" per page over in-stock offers with
 * the tie broken by render order (AC4); and the discriminating end-to-end
 * regression (AC5) drives the REAL runner on a duplicated offer list and
 * renders the cascade, asserting one card for the duplicate, exactly one
 * badge, and preserved distinct-SKU rows.
 *
 * Live-data fidelity note: every row comes from the group's own fetched hits
 * — the dedupe folds only listings that are literally the same URL, so
 * distinct retailer SKUs (plain vs "Japanese Version") keep their rows.
 */
// @vitest-environment jsdom
import "./test-cache-dir";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchHit } from "@/lib/collect/live-search";
import { groupHits } from "@/lib/collect/live-search";
import { normalizedListingUrlOf } from "@/lib/collect/types";
import { PulseOfferCascade } from "@/components/CollectionPulse";
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
afterEach(cleanup);

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

describe("REEA-908 spec §1 — normalized dedupe key and cheapest survivor", () => {
  it("normalizedListingUrlOf lowercases the host and strips query/hash/trailing slash", () => {
    expect(normalizedListingUrlOf("HTTPS://Wibi.com.kw/p/x/")).toBe("https://wibi.com.kw/p/x");
    expect(normalizedListingUrlOf("https://wibi.com.kw/p?variant=12")).toBe(
      "https://wibi.com.kw/p",
    );
    expect(normalizedListingUrlOf("https://wibi.com.kw/p/#top")).toBe("https://wibi.com.kw/p");
    // The path itself compares as-is.
    expect(normalizedListingUrlOf("https://wibi.com.kw/p")).not.toBe(
      normalizedListingUrlOf("https://wibi.com.kw/p/512gb"),
    );
  });

  it("grouping folds query-string / trailing-slash / case variants of one listing into ONE row", () => {
    const products = groupHits("iphone 17 pro max", [
      hit({ title: "Apple iPhone 17 Pro Max 512GB Silver", price: 409.9, url: "https://wibi.com.kw/products/listing" }),
      hit({ title: "Apple iPhone 17 Pro Max 512GB Silver 5G", price: 412, url: "https://wibi.com.kw/products/listing?variant=12" }),
      hit({ title: "Apple iPhone 17 Pro Max 512GB Silver eSIM", price: 415, url: "https://WIBI.com.kw/products/listing/" }),
    ]);
    const card = products.find((p) => p.offers.some((o) => o.merchant === "Wibi"));
    expect(card?.offers.filter((o) => o.merchant === "Wibi")).toHaveLength(1);
    // Cheapest occurrence survives, rendered verbatim.
    expect(card?.offers.find((o) => o.merchant === "Wibi")?.price).toBe(409.9);
  });

  it("uniqueListings folds URL-noise duplicates for the fan-out", () => {
    const uniq = uniqueListings([
      { merchant: "Wibi", price: 409.9, url: "https://wibi.com.kw/p" },
      { merchant: "Wibi", price: 410, url: "https://wibi.com.kw/p?variant=1" },
      { merchant: "Wibi", price: 411, url: "https://WIBI.com.kw/p/" },
    ]);
    expect(uniq).toHaveLength(1);
  });
});


// REEA-908 AC5 — DISCRIMINATING end-to-end regression (aggregation → render):
// the REAL runner consumes a product-offer list carrying an exact duplicate
// (same merchant + URL) plus distinct-URL same-retailer offers, and the
// cascade renders the collected offers. Assertions: exactly one card for the
// duplicated listing (AC1), distinct-URL same-retailer cards preserved (AC2),
// and exactly ONE "Best price" badge on the page (AC4). Recorded both
// directions per AC5: failing output captured on the pre-fix build (ff288a4),
// passing output on the fix — both pasted in the issue thread.
describe("REEA-908 AC5 — discriminating dedupe + single-badge regression", () => {
  const wibiListing = "https://wibi.com.kw/products/apple-iphone-17-pro-max-512gb-deep-blue-dual-e-sim";
  const duplicatedShelf = product([
    { merchant: "Wibi", price: 414.9, currency: "KWD", url: wibiListing, inStock: true },
    // The exact duplicate: same merchant, same listing (query-string noise on
    // the second stamp) — one purchasable unit, never two cards.
    { merchant: "Wibi", price: 414.9, currency: "KWD", url: `${wibiListing}?utm=feed`, inStock: true },
    // Legit same-retailer multiples that MUST survive (AC2).
    { merchant: "Blink", price: 364.9, currency: "KWD", url: "https://blink.com.kw/products/apple-iphone-17-pro-max-japanese-version", inStock: true },
    { merchant: "Blink", price: 369, currency: "KWD", url: "https://blink.com.kw/products/apple-iphone-17-pro-max", inStock: true },
    { merchant: "Zayoom", price: 379.9, currency: "KWD", url: "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver", inStock: true },
    { merchant: "Zayoom", price: 399.9, currency: "KWD", url: "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver-japanese", inStock: true },
  ]);

  // Price-faithful scrape stub: each listing's PDP answers with ITS OWN price
  // (meta tag, the Shopify convention REEA-896 pinned), so the collected
  // offers carry the shelf's real figures and the AC2/AC4 price assertions
  // exercise the actual render values.
  const shelfPrices: Record<string, number> = {
    [wibiListing]: 414.9,
    "https://blink.com.kw/products/apple-iphone-17-pro-max-japanese-version": 364.9,
    "https://blink.com.kw/products/apple-iphone-17-pro-max": 369,
    "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver": 379.9,
    "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver-japanese": 399.9,
  };
  const shelfFetch = (url: string): Promise<Response> => {
    const price = shelfPrices[normalizedListingUrlOf(url)] ?? 999;
    return Promise.resolve(
      new Response(
        `<meta property="product:price:amount" content="${price}"><meta property="product:price:currency" content="KWD">`,
        { status: 200 },
      ),
    );
  };

  it("collects one offer per unique listing and renders exactly one card per (merchant, URL)", async () => {
    const { job } = await startCollection(duplicatedShelf, { force: true });
    const done = await runCollection(job, duplicatedShelf, { fetchImpl: shelfFetch, now: 1_000_000 });
    expect(done.status).toBe("complete");
    // AC1: at most one card per (merchant, normalized URL) — the duplicated
    // Wibi listing renders ONCE even though the product-offer list carried it
    // twice, and its scraped offers cannot stack.
    expect(done.offers.filter((o) => o.merchant === "Wibi")).toHaveLength(1);
    const keys = done.offers.map((o) => `${o.merchant}|${normalizedListingUrlOf(o.url)}`);
    expect(new Set(keys).size).toBe(keys.length);
    // AC2: distinct-URL same-retailer offers preserved with their prices.
    expect(done.offers.filter((o) => o.merchant === "Blink").map((o) => o.price)).toEqual([364.9, 369]);
    expect(done.offers.filter((o) => o.merchant === "Zayoom").map((o) => o.price)).toEqual([379.9, 399.9]);

    // Render layer: the cascade over the collected offers shows the same
    // card set and AC4's single badge.
    const { container } = render(<PulseOfferCascade offers={done.offers} />);
    const cards = Array.from(container.querySelectorAll("article"));
    expect(cards.filter((c) => c.textContent?.includes("Wibi"))).toHaveLength(1);
    expect(cards.filter((c) => c.textContent?.includes("Blink"))).toHaveLength(2);
    expect(cards.filter((c) => c.textContent?.includes("Zayoom"))).toHaveLength(2);
    // AC4: exactly ONE badge, on the cheapest in-stock card (Blink 364.9).
    expect(screen.getAllByText("Best price")).toHaveLength(1);
    const badged = cards.find((c) => c.querySelector(".best-flag"));
    expect(badged?.textContent).toContain("Blink");
  });
});

describe("REEA-908 AC4 — badge rule edge cases", () => {
  function cascadeOffer(over: { merchant: string; url: string; price?: number; inStock?: boolean }) {
    return {
      merchant: over.merchant,
      domain: new URL(over.url).hostname,
      price: over.price ?? 100,
      currency: "KWD",
      url: over.url,
      inStock: over.inStock ?? true,
      collectedAt: "2026-09-13T12:00:00.000Z",
      method: "live" as const,
    };
  }

  it("a price tie badges only the FIRST rendered card, never both", () => {
    const { container } = render(
      <PulseOfferCascade
        offers={[
          cascadeOffer({ merchant: "Alpha", url: "https://alpha.example/p" }),
          cascadeOffer({ merchant: "Beta", url: "https://beta.example/p" }),
          cascadeOffer({ merchant: "Gamma", price: 120, url: "https://gamma.example/p" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Best price")).toHaveLength(1);
    const badged = Array.from(container.querySelectorAll("article")).find((c) =>
      c.querySelector(".best-flag"),
    );
    expect(badged?.textContent).toContain("Alpha");
  });

  it("the badge lands on the cheapest IN-STOCK card when a cheaper out-of-stock card exists", () => {
    const { container } = render(
      <PulseOfferCascade
        offers={[
          cascadeOffer({ merchant: "CheapOOS", price: 50, url: "https://cheapoos.example/p", inStock: false }),
          cascadeOffer({ merchant: "Stocked", price: 80, url: "https://stocked.example/p" }),
          cascadeOffer({ merchant: "Pricier", price: 120, url: "https://pricier.example/p" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Best price")).toHaveLength(1);
    const badged = Array.from(container.querySelectorAll("article")).find((c) =>
      c.querySelector(".best-flag"),
    );
    expect(badged?.textContent).toContain("Stocked");
  });

  it("an all-out-of-stock page still badges exactly one card", () => {
    render(
      <PulseOfferCascade
        offers={[
          cascadeOffer({ merchant: "Alpha", price: 50, url: "https://alpha.example/p", inStock: false }),
          cascadeOffer({ merchant: "Beta", price: 80, url: "https://beta.example/p", inStock: false }),
        ]}
      />,
    );
    expect(screen.getAllByText("Best price")).toHaveLength(1);
  });
});
