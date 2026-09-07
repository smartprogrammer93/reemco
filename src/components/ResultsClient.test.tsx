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
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ResultsClient from "@/components/ResultsClient";
import HeaderSearch from "@/components/HeaderSearch";
import { resetStockPrefs } from "@/lib/stock";
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

describe("country filter UI (REEA-170)", () => {
  const MIXED: NormalizedProduct[] = [
    {
      productId: "airpods-pro-2",
      title: "Apple AirPods Pro 2",
      brand: "Apple",
      offers: [
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
        { merchant: "Jarir", price: 909, currency: "SAR", url: "https://jarir.example/p", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
  ];

  it("renders the pills and keeps only matching-offer retailers under Kuwait", async () => {
    searchParams.set("q", "airpods");
    await act(async () => {
      render(
        <ResultsClient query="airpods" page={1} products={MIXED} suggestions={MIXED} country="KW" />,
      );
    });
    const pills = Array.from(document.querySelectorAll('nav[aria-label="Filter offers by country"] a'));
    expect(pills.map((a) => a.textContent)).toEqual([
      "All",
      "Kuwait (KWD)",
      "Saudi Arabia (SAR)",
      "Egypt (EGP)",
    ]);
    // Pills are plain links: the selection rides the URL for the next request.
    expect(pills[1].getAttribute("href")).toBe("/results?q=airpods&c=KW");
    expect(pills[1].getAttribute("aria-current")).toBe("true");
    expect(pills[0].getAttribute("href")).toBe("/results?q=airpods");
    // Offer rows honor the selection: the SAR listing is suppressed, the KWD
    // one stays.
    const html = document.body.innerHTML;
    expect(html).toContain("Xcite");
    expect(html).not.toContain("Jarir");
  });

  it("the header search carries the active selection into the next query", async () => {
    searchParams.set("q", "airpods");
    searchParams.set("c", "KW");
    await act(async () => {
      render(<HeaderSearch />);
    });
    const hidden = document.querySelector('input[name="c"]');
    expect((hidden as HTMLInputElement | null)?.value).toBe("KW");
  });
});

describe("stock selection UI (REEA-186)", () => {
  const MIXED_STOCK: NormalizedProduct[] = [
    {
      productId: "sony-wh-1000xm6",
      title: "Sony WH-1000XM6",
      brand: "Sony",
      offers: [
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
        { merchant: "Jarir", price: 69, currency: "SAR", url: "https://jarir.example/p", inStock: false },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
  ];

  beforeEach(() => {
    // Deterministic baseline: the shared mocked searchParams may carry the
    // country selection from the REEA-170 block above.
    searchParams.delete("oos");
    searchParams.delete("c");
    resetStockPrefs();
  });

  it("hides out-of-stock listings by default and shows the toggle unchecked", async () => {
    searchParams.set("q", "xm6");
    await act(async () => {
      render(<ResultsClient query="xm6" page={1} products={MIXED_STOCK} suggestions={MIXED_STOCK} />);
    });
    // Default: only the in-stock listing renders.
    const html = document.body.innerHTML;
    expect(html).toContain("Xcite");
    expect(html).not.toContain("Jarir");
    // Visible checkbox-style toggle, unchecked, linking to the opt-in state.
    const toggle = document.querySelector('[role="checkbox"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("Show out-of-stock items");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.getAttribute("href")).toBe("/results?q=xm6&oos=1");
  });

  it("shows every listing while the toggle is checked, and unchecked hides again", async () => {
    searchParams.set("q", "xm6");
    searchParams.set("oos", "1");
    await act(async () => {
      render(
        <ResultsClient query="xm6" page={1} products={MIXED_STOCK} suggestions={MIXED_STOCK} showOutOfStock />,
      );
    });
    const html = document.body.innerHTML;
    expect(html).toContain("Xcite");
    expect(html).toContain("Jarir");
    const toggle = document.querySelector('[role="checkbox"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    // Unchecking drops the flag — the next request is back to default-hide.
    expect(toggle?.getAttribute("href")).toBe("/results?q=xm6");
  });

  it("the header search carries the stock selection into the next query", async () => {
    searchParams.set("q", "xm6");
    searchParams.set("oos", "1");
    await act(async () => {
      render(<HeaderSearch />);
    });
    const hidden = document.querySelector('input[name="oos"]');
    expect((hidden as HTMLInputElement | null)?.value).toBe("1");
  });
});
