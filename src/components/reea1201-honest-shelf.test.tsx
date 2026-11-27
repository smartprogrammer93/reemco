// @vitest-environment jsdom
/**
 * REEA-1201 (Bet 7A-2) — the shopper-facing honest shelf: the in-scope count
 * line, the labelled accessory band and the thin-shelf sentence, in EN and AR.
 *
 * These render the results surface from a payload that carries the relevance
 * gate's `productScope` (REEA-1200). The assertions pin the ACs: the count is
 * the primary-scope card count, accessory cards never sit above a primary card,
 * and a single-retailer shelf says so instead of implying a comparison.
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
import type { NormalizedProduct } from "@/types/product";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const kwd = (merchant: string, price: number): NormalizedProduct["offers"][number] => ({
  merchant,
  price,
  currency: "KWD",
  url: `https://${merchant.toLowerCase()}.example/p`,
  inStock: true,
});

function product(
  id: string,
  title: string,
  scope: NormalizedProduct["productScope"],
  offers: NormalizedProduct["offers"],
): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "Samsung",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
    productScope: scope,
  };
}

const S25_SHELF: NormalizedProduct[] = [
  product("s25-ultra", "Samsung Galaxy S25 Ultra", "primary", [kwd("Xcite", 289.9), kwd("Jarir", 299.9)]),
  product("s25-plus", "Samsung Galaxy S25+", "primary", [kwd("Eureka", 279.9), kwd("Xcite", 269.9)]),
  product("case", "Samsung Galaxy S25 Ultra Silicone Case", "accessory", [kwd("Xcite", 9.9)]),
  product("protector", "Samsung Galaxy S25 Ultra Screen Protector", "accessory", [kwd("Jarir", 4.9)]),
];

const THIN_SHELF: NormalizedProduct[] = [
  product("panadol", "Panadol Pain Relief Tablets", "primary", [kwd("Xcite", 1.5)]),
  product("panadrex", "Panadrex Tablets", "primary", [kwd("Jarir", 1.7)]),
];

function renderResults(products: NormalizedProduct[], locale: "en" | "ar", query: string) {
  resetCountryPrefs();
  vi.stubGlobal("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    sendBeacon: () => true,
  });
  return render(
    <ResultsClient
      query={query}
      products={products}
      country="KW"
      showOutOfStock={false}
      locale={locale}
      renderStartMs={Date.parse("2026-11-26T00:00:05.000Z")}
    />,
  );
}

describe("REEA-1201 AC 7b-1 — the count line is the payload count (EN)", () => {
  it("states 2 exact-model retailers and the number is the primary shelf count", () => {
    const { container } = renderResults(S25_SHELF, "en", "samsung galaxy s25 ultra");
    // REEA-1261 AC-2 — "samsung galaxy s25 ultra" names a curated brand AND a
    // model token, so the count line is the exact-model sentence. The number
    // is still the payload's primary card count: the sentence and the shelf
    // read the same predicate, so they cannot disagree.
    const line = container.querySelector("[data-exact-model-count]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toBe("2 retailers carry this exact model");
    expect(line.getAttribute("data-exact-model-total")).toBe("2");
    expect(line.getAttribute("data-exact-model-none-in-market")).toBe("false");
    // The number equals the primary-scope cards actually rendered.
    expect(container.querySelectorAll("[data-primary-section] article.rc-card").length).toBe(2);
  });

  it("keeps the in-scope count line on a query that names no brand+model", () => {
    const { container } = renderResults(THIN_SHELF, "en", "panadol");
    const line = container.querySelector("[data-in-scope-count]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("2 in-scope products");
    expect(line.getAttribute("data-in-scope-total")).toBe("2");
    expect(container.querySelector("[data-exact-model-count]")).toBeNull();
  });
});

describe("REEA-1201 AC 7b-1 — AR count line", () => {
  it("states the Arabic dual form for 2 exact-model retailers", () => {
    const { container } = renderResults(S25_SHELF, "ar", "samsung galaxy s25 ultra");
    const line = container.querySelector("[data-exact-model-count]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("متجران يبيعان هذا الموديل بالضبط");
    expect(line.getAttribute("data-exact-model-total")).toBe("2");
  });

  it("keeps the Arabic in-scope ladder on a non-exact query", () => {
    const { container } = renderResults(THIN_SHELF, "ar", "panadol");
    const line = container.querySelector("[data-in-scope-count]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("منتجان ضمن نطاق البحث");
  });
});

describe("REEA-1201 AC 7b-2 — the labelled accessory band", () => {
  it("renders the EN label and keeps accessory cards out of the primary shelf", () => {
    const { container } = renderResults(S25_SHELF, "en", "samsung galaxy s25 ultra");
    const band = container.querySelector("[data-accessory-band]") as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.textContent).toContain("Accessories for this product");
    expect(band.querySelectorAll("[data-accessory-item]").length).toBe(2);
    // No accessory title inside the primary section.
    const primary = container.querySelector("[data-primary-section]") as HTMLElement;
    expect(primary.textContent).not.toContain("Silicone Case");
    expect(primary.textContent).not.toContain("Screen Protector");
    // The band sits after the primary shelf in document order.
    const order = Array.from(container.querySelectorAll("[data-primary-section], [data-accessory-band]")).map(
      (el) => (el.hasAttribute("data-primary-section") ? "primary" : "accessory"),
    );
    expect(order).toEqual(["primary", "accessory"]);
  });

  it("renders the pinned Arabic label", () => {
    const { container } = renderResults(S25_SHELF, "ar", "samsung galaxy s25 ultra");
    const band = container.querySelector("[data-accessory-band]") as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.textContent).toContain("ملحقات هذا المنتج");
  });
});

describe("REEA-1201 AC 7b-3 — thin-shelf honesty", () => {
  it("says no cross-retailer match was found when every card has one retailer (EN)", () => {
    const { container } = renderResults(THIN_SHELF, "en", "panadol");
    const line = container.querySelector("[data-thin-shelf]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("No cross-retailer match was found");
    expect(line.textContent).toContain("panadol");
    expect(line.textContent).toContain("single-retailer offers");
  });

  it("says it in Arabic too", () => {
    const { container } = renderResults(THIN_SHELF, "ar", "panadol");
    const line = container.querySelector("[data-thin-shelf]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("لم نجد مطابقة عبر أكثر من متجر");
    expect(line.textContent).toContain("عروض متجر واحد");
  });

  it("does not appear when a card carries two in-market retailers", () => {
    const { container } = renderResults(S25_SHELF, "en", "samsung galaxy s25 ultra");
    expect(container.querySelector("[data-thin-shelf]")).toBeNull();
  });
});
