// @vitest-environment jsdom
/**
 * REEA-1147 AC2 — a card with ONE in-market retailer must not present itself
 * as a cross-store comparison: it renders "1 retailer" (EN and AR) and shows
 * no savings / "best effective price" claim. A card with two in-market
 * retailers keeps the comparison claim.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import type { NormalizedProduct } from "@/types/product";

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

afterEach(() => cleanup());

function product(offers: NormalizedProduct["offers"]): NormalizedProduct {
  return {
    productId: "s25-ultra",
    title: "Samsung Galaxy S25 Ultra",
    brand: "Samsung",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-24T00:00:00.000Z",
  };
}

const oneInMarket: NormalizedProduct["offers"] = [
  {
    merchant: "Xcite",
    price: 289.9,
    currency: "KWD",
    url: "https://xcite.example/s25",
    inStock: true,
    wasPrice: 329.9,
  },
  {
    merchant: "Jarir",
    price: 3999,
    currency: "SAR",
    url: "https://jarir.example/s25",
    inStock: true,
  },
];

const twoInMarket: NormalizedProduct["offers"] = [
  ...oneInMarket,
  {
    merchant: "Eureka",
    price: 299.9,
    currency: "KWD",
    url: "https://eureka.example/s25",
    inStock: true,
  },
];

describe("REEA-1147 AC2 — a single in-market retailer is not a comparison (EN)", () => {
  it("renders '1 retailer' instead of the best-effective-price basis", () => {
    const { container } = render(<ProductResultCard product={product(oneInMarket)} query="samsung galaxy s25 ultra" rank={0} locale="en" />);
    const basis = container.querySelector(".rc-card-basis")!;
    expect(basis.textContent).toBe("1 retailer");
    expect(container.textContent).not.toContain("best effective price");
  });

  it("shows no savings claim even when the store carries a compare-at price", () => {
    const { container } = render(<ProductResultCard product={product(oneInMarket)} query="samsung galaxy s25 ultra" rank={0} locale="en" />);
    expect(container.querySelector(".rc-savings")).toBeNull();
    expect(container.textContent).not.toContain("Save");
  });

  it("counts only the in-market retailer in the footer, never the SAR row", () => {
    const { container } = render(<ProductResultCard product={product(oneInMarket)} query="samsung galaxy s25 ultra" rank={0} locale="en" />);
    expect(container.textContent).toContain("1 retailer");
    expect(container.textContent).not.toContain("2 retailers");
  });
});

describe("REEA-1147 AC2 — a single in-market retailer is not a comparison (AR)", () => {
  it("renders the Arabic 'متجر' count and no Arabic best-effective claim", () => {
    const { container } = render(<ProductResultCard product={product(oneInMarket)} query="samsung galaxy s25 ultra" rank={0} locale="ar" />);
    const basis = container.querySelector(".rc-card-basis")!;
    expect(basis.textContent).toBe("1 متجر");
    expect(container.textContent).not.toContain("أفضل سعر فعلي");
  });
});

describe("REEA-1147 AC2 — two in-market retailers keep the comparison claim", () => {
  it("renders the best-effective-price basis and the savings chip", () => {
    const { container } = render(<ProductResultCard product={product(twoInMarket)} query="samsung galaxy s25 ultra" rank={0} locale="en" />);
    expect(container.querySelector(".rc-card-basis")!.textContent).toBe("best effective price");
    expect(container.querySelector(".rc-savings")).not.toBeNull();
  });
});
