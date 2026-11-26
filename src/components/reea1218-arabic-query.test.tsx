// @vitest-environment jsdom
/**
 * REEA-1218 (Bet 8) — shopper-facing Arabic coverage.
 *
 * AC-3: when the Arabic query is served under its curated Latin alias, the
 * shelf renders the Arabic substitution line naming the alias. AC-4: a
 * zero-result Arabic query renders the Arabic empty state with three concrete
 * Arabic suggestions from the same lexicon.
 */
import { cleanup, render } from "@testing-library/react";
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
import type { NormalizedProduct } from "@/types/product";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCountryPrefs();
  resetStockPrefs();
});

const washer: NormalizedProduct = {
  productId: "lg-washer-8kg",
  title: "LG Washing Machine 8kg Front Load",
  brand: "LG",
  offers: [
    {
      merchant: "Xcite",
      price: 189.9,
      currency: "KWD",
      url: "https://xcite.example/washer",
      inStock: true,
    },
  ],
  coupons: [],
  variations: [],
  alternatives: [],
  scrapedAt: "2026-11-26T00:00:00.000Z",
  productScope: "primary",
  matchReason: "query_token",
};

describe("REEA-1218 — Arabic substitution line", () => {
  it("names the Latin alias next to the shopper's Arabic query", () => {
    const { container, getByText } = render(
      <ResultsClient query="غسالة" products={[washer]} country="KW" showOutOfStock={false} locale="ar" />,
    );
    const line = container.querySelector("[data-alias-substitution]");
    expect(line).not.toBeNull();
    expect(line?.getAttribute("data-alias-from")).toBe("غسالة");
    expect(line?.getAttribute("data-alias-to")).toBe("washing machine");
    expect(getByText(/بحثنا عن washing machine بدلًا من/)).toBeTruthy();
    // The true in-scope count line still renders beside the disclosure.
    expect(getByText(/ضمن نطاق البحث عن/)).toBeTruthy();
  });

  it("does not show a substitution line for a purely-Latin query", () => {
    const { container } = render(
      <ResultsClient query="washing machine" products={[washer]} country="KW" showOutOfStock={false} locale="en" />,
    );
    expect(container.querySelector("[data-alias-substitution]")).toBeNull();
  });
});

describe("REEA-1218 — Arabic empty state", () => {
  it("renders the Arabic empty state with three lexicon suggestions", () => {
    const { container, getByText } = render(
      <ResultsClient query="زجاجة" products={[]} country="KW" showOutOfStock={false} locale="ar" />,
    );
    expect(container.querySelector("[data-empty-state]")).not.toBeNull();
    const suggestions = container.querySelector("[data-empty-suggestions]");
    expect(suggestions).not.toBeNull();
    const labels = Array.from(suggestions?.querySelectorAll("a") ?? []).map((a) => a.textContent);
    expect(labels).toEqual(["غسالة", "لابتوب", "بانادول"]);
    expect(getByText("لا توجد مطابقة")).toBeTruthy();
  });
});
