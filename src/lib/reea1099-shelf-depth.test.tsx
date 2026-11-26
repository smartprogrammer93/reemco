// @vitest-environment jsdom
/**
 * REEA-1099 AC2 — fixture test pinning the comparison-depth increment to the
 * RESULTS-PAGE SHELF CARDS the same fixture renders.
 *
 * The defect this pins (measured live on build `50cc3ae`): the counter folded
 * every product in the live snapshot, so a two-query serve recorded 20 cards
 * while the page painted 10. The extra population is the related band (rendered
 * as chips, never result cards — REEA-964), rows dropped by the stock/country
 * selections, and offers the card itself hides (an out-of-stock retailer row is
 * not a comparison the shopper can make).
 *
 * Tolerance: the fixture is deterministic, so the tolerance is ZERO cards —
 * `applySearchOutcome` must record exactly the `article.result-card` count the
 * same query/build renders. (The live probe's documented tolerance exists only
 * for streamed-HTML duplicate counting; see the ticket comment.)
 */
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same act environment the repo's other render fixtures use.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ResultsClient from "@/components/ResultsClient";
import { applySearchOutcome, comparisonDepthOf, type WeekCountersMap } from "@/lib/metrics";
import { resultsShelfCards } from "@/lib/results-shelf";
import { searchOutcomeFromSnapshot } from "@/lib/metrics";
import type { LiveSearchResult } from "@/lib/collect/live-search";
import type { NormalizedProduct } from "@/types/product";

const QUERY = "iphone 17 pro";
const WEEK = "2026-W48";

function product(id: string, title: string, offers: NormalizedProduct["offers"]): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "Apple",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-23T10:00:00.000Z",
  };
}

/**
 * Five snapshot products, three of which are results-page shelf cards:
 *  1. primary, two IN-STOCK retailers      → card, multi-retailer
 *  2. primary, one in-stock retailer       → card, single
 *  3. primary, one in-stock + one OOS      → card, single (the OOS row is
 *     dropped before paint, so it is not a second retailer on screen)
 *  4. related-band accessory (low confidence) → chip, NOT a card
 *  5. out-of-stock-only card                → dropped by the stock selection
 * The pre-REEA-1099 counter folded all five and called #3 multi-retailer.
 */
const SNAP: LiveSearchResult = {
  products: [
    product("iphone-17-pro-256", "Apple iPhone 17 Pro 256GB", [
      { merchant: "Xcite", price: 319.9, currency: "KWD", url: "https://www.xcite.com/p/1", inStock: true },
      { merchant: "Jarir", price: 339, currency: "KWD", url: "https://www.jarir.com/p/1", inStock: true },
    ]),
    product("iphone-17-128", "Apple iPhone 17 128GB", [
      { merchant: "Wibi", price: 204.9, currency: "KWD", url: "https://wibi.com.kw/p/1", inStock: true },
    ]),
    product("iphone-17-pro-512", "Apple iPhone 17 Pro 512GB", [
      { merchant: "Xcite", price: 449.9, currency: "KWD", url: "https://www.xcite.com/p/2", inStock: true },
      { merchant: "Jarir", price: 459, currency: "KWD", url: "https://www.jarir.com/p/2", inStock: false },
    ]),
    product("iphone-17-pro-case", "iPhone 17 Pro Case", [
      { merchant: "Xcite", price: 12.9, currency: "KWD", url: "https://www.xcite.com/p/3", inStock: true },
    ]),
    product("iphone-17-pro-oos", "Apple iPhone 17 Pro 256GB — Blue", [
      { merchant: "Eureka", price: 349.9, currency: "KWD", url: "https://www.eureka.com.kw/p/1", inStock: false },
    ]),
  ],
  notes: [
    { merchant: "Xcite", hits: 3 },
    { merchant: "Jarir", hits: 2 },
    { merchant: "Wibi", hits: 1 },
  ],
  suggestions: [],
  settled: true,
};

beforeEach(() => {
  searchParams.set("q", QUERY);
  searchParams.delete("oos");
  searchParams.delete("c");
  // The follow-up feed is irrelevant to a settled fixture; fail it quietly.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no feed"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("REEA-1099 AC2 comparison-depth increment == rendered shelf cards", () => {
  it("renders exactly the shelf slice the counter folds, and records that count", async () => {
    // 1. The renderer's own population (shared definition with the counter).
    const cards = resultsShelfCards(SNAP, QUERY, 1, null, false);
    const depth = comparisonDepthOf(cards);

    // 2. The page itself, from the same fixture and query.
    await act(async () => {
      render(<ResultsClient query={QUERY} page={1} country={null} stages={[Promise.resolve(SNAP)]} />);
    });
    const painted = document.querySelectorAll("article.result-card");
    const paintedMulti = [...painted].filter((card) => {
      const names = new Set(
        [...card.querySelectorAll(".rc-retailer-name")].map((n) => (n.textContent || "").trim().toLowerCase()).filter(Boolean),
      );
      return names.size >= 2;
    }).length;

    // 3. Pinned equality — zero tolerance on a deterministic fixture.
    expect(painted).toHaveLength(3);
    expect(paintedMulti).toBe(1);
    expect(depth).toEqual({ cardsTotal: 3, cardsMultiRetailer: 1, cardsCrossMarket: 0 });
    expect(depth.cardsTotal).toBe(painted.length);
    expect(depth.cardsMultiRetailer).toBe(paintedMulti);

    // 4. The recorded increment is that same number, not the snapshot's 5.
    const weeks: WeekCountersMap = {};
    applySearchOutcome(weeks, WEEK, {
      ...searchOutcomeFromSnapshot(SNAP, cards),
      serveOutcome: "full",
      serveLatencyMs: 900,
    });
    expect(SNAP.products).toHaveLength(5);
    expect(weeks[WEEK].comparison_cards_total).toBe(painted.length);
    expect(weeks[WEEK].comparison_cards_multi_retailer).toBe(paintedMulti);
  });
});
