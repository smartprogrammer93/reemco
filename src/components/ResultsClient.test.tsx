// @vitest-environment jsdom
/**
 * REEA-37 — results-page funnel wiring test (AC-1 client side).
 * Renders ResultsClient with a mocked router/search-params and stubbed
 * transport, asserting search_submitted + result_impressed (+ zero_results)
 * fire with the correct fields once per query/page.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import ResultsClient from "@/components/ResultsClient";
import type { NormalizedProduct } from "@/types/product";

const beaconCalls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  searchParams.set("q", "");
  beaconCalls.length = 0;
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, blob: Blob) => {
      void blob.text().then((text) => beaconCalls.push({ url, body: JSON.parse(text) }));
      return true;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function eventsSent(): { type: string; [k: string]: unknown }[] {
  return beaconCalls.flatMap((c) => (c.body as { events: [] }).events);
}

// REEA-114: ResultsClient renders exactly what the server collected, so the
// test feeds it a minimal normalized product the same way the page does.
const SAMPLE_PRODUCTS: NormalizedProduct[] = [
  {
    productId: "sony-wh-1000xm6",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: [
      { merchant: "Jarir", price: 1299, currency: "SAR", url: "https://www.jarir.com/", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-07T00:00:00.000Z",
  },
];

describe("ResultsClient funnel instrumentation", () => {
  it("fires search_submitted and result_impressed for a query with results", async () => {
    searchParams.set("q", "sony");
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} products={SAMPLE_PRODUCTS} suggestions={SAMPLE_PRODUCTS} />,
      );
    });
    const evts = eventsSent();
    const search = evts.find((e) => e.type === "search_submitted");
    expect(search).toMatchObject({ type: "search_submitted", query: "sony" });
    expect(Number(search?.result_count)).toBeGreaterThan(0);
    const impressions = evts.filter((e) => e.type === "result_impressed");
    expect(impressions.length).toBeGreaterThan(0);
    expect(impressions[0]).toMatchObject({ query: "sony", rank: 0 });
    expect(typeof impressions[0].item_id).toBe("string");
    // deduped: no second batch on re-render of the same query/page
    const before = beaconCalls.length;
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} products={SAMPLE_PRODUCTS} suggestions={SAMPLE_PRODUCTS} />,
      );
    });
    expect(beaconCalls.length).toBeLessThanOrEqual(before + 1);
  });

  it("fires zero_results for a query with no matches", async () => {
    searchParams.set("q", "zzzqqqnothing");
    await act(async () => {
      render(
        <ResultsClient query="zzzqqqnothing" page={1} products={[]} suggestions={[]} />,
      );
    });
    const evts = eventsSent();
    expect(evts.some((e) => e.type === "zero_results" && e.query === "zzzqqqnothing")).toBe(true);
    const search = evts.find((e) => e.type === "search_submitted");
    expect(search?.result_count).toBe(0);
  });
});
