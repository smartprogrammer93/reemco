// @vitest-environment jsdom
/**
 * REEA-1270 (Bet 3) AC R-2 — when a bounded near-miss correction is applied,
 * the page names the spelling it actually searched ("Showing results for
 * “iphone 17 pro”" / the AR equivalent). Never a silent substitution: the
 * line carries the from/to pair so QA can read it off the served document,
 * and it renders on both the shelf and the zero-page (empty-state) path.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/results",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
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
import { resetCountryPrefs } from "@/lib/country";
import { resetStockPrefs } from "@/lib/stock";
import type { LiveSearchResult } from "@/lib/collect/live-search";
import type { NormalizedProduct } from "@/types/product";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCountryPrefs();
  resetStockPrefs();
});

const phone: NormalizedProduct = {
  productId: "apple-iphone17pro-256gb",
  title: "Apple iPhone 17 Pro 256GB",
  brand: "Apple",
  offers: [
    {
      merchant: "Xcite",
      price: 469,
      currency: "KWD",
      url: "https://xcite.example/iphone17pro",
      inStock: true,
    },
  ],
  coupons: [],
  variations: [],
  alternatives: [],
  scrapedAt: "2026-11-27T00:00:00.000Z",
  productScope: "primary",
  matchReason: "query_token",
};

const correction = {
  from: "iphon 17 pro",
  to: "iphone 17 pro",
  tokens: [{ from: "iphon", to: "iphone" }],
};

describe("REEA-1270 R-2 — the correction is named on the page", () => {
  it("names the corrected spelling on the served shelf (EN)", async () => {
    const snap: LiveSearchResult = {
      products: [phone],
      notes: [{ merchant: "Xcite", hits: 1 }],
      suggestions: [phone],
      settled: true,
      correction,
      attemptedQueries: ["iphon 17 pro", "iphone 17 pro"],
    };
    await act(async () => {
      render(
        <ResultsClient
          query="iphon 17 pro"
          page={1}
          country="KW"
          showOutOfStock={false}
          locale="en"
          stages={[Promise.resolve(snap), Promise.resolve(snap)]}
        />,
      );
    });
    const line = document.querySelector("[data-near-miss-correction]");
    expect(line).not.toBeNull();
    expect(line?.getAttribute("data-near-miss-from")).toBe("iphon 17 pro");
    expect(line?.getAttribute("data-near-miss-to")).toBe("iphone 17 pro");
    expect((document.body.textContent ?? "").replace(/\s+/g, " ")).toContain(
      "Showing results for “iphone 17 pro”",
    );
  });

  it("names the corrected spelling in Arabic on the AR view", async () => {
    const snap: LiveSearchResult = {
      products: [phone],
      notes: [{ merchant: "Xcite", hits: 1 }],
      suggestions: [phone],
      settled: true,
      correction,
      attemptedQueries: ["iphon 17 pro", "iphone 17 pro"],
    };
    await act(async () => {
      render(
        <ResultsClient
          query="iphon 17 pro"
          page={1}
          country="KW"
          showOutOfStock={false}
          locale="ar"
          stages={[Promise.resolve(snap), Promise.resolve(snap)]}
        />,
      );
    });
    const line = document.querySelector("[data-near-miss-correction]");
    expect(line).not.toBeNull();
    expect((document.body.textContent ?? "").replace(/\s+/g, " ")).toContain(
      "عرض النتائج لـ «iphone 17 pro»",
    );
  });

  it("names the correction on a corrected zero page too (never silent)", () => {
    const { container } = render(
      <ResultsClient
        query="iphon 17 pro"
        products={[]}
        country="KW"
        showOutOfStock={false}
        locale="en"
        correction={correction}
      />,
    );
    expect(container.querySelector('[data-empty-state="true"]')).not.toBeNull();
    const line = container.querySelector("[data-near-miss-correction]");
    expect(line).not.toBeNull();
    expect(container.textContent ?? "").toContain("Showing results for “iphone 17 pro”");
  });

  it("renders no correction line when the query was dispatched as typed", async () => {
    const snap: LiveSearchResult = {
      products: [phone],
      notes: [{ merchant: "Xcite", hits: 1 }],
      suggestions: [phone],
      settled: true,
    };
    await act(async () => {
      render(
        <ResultsClient
          query="iphone 17 pro"
          page={1}
          country="KW"
          showOutOfStock={false}
          locale="en"
          stages={[Promise.resolve(snap), Promise.resolve(snap)]}
        />,
      );
    });
    expect(document.querySelector("[data-near-miss-correction]")).toBeNull();
  });
});
