// @vitest-environment jsdom
/**
 * REEA-1161 — 375px cross-market label clipping, render-side pins.
 *
 * The layout proof is the browser probe (scripts/reea1161-probe.mjs) against
 * the served page: zero clipped `.label-token`, no horizontal overflow. These
 * pins hold the markup contract that fix depends on:
 *  - a cross-market offer row carries `has-market`, so the ≤640 CSS can let
 *    its line-a wrap instead of squeezing every label into one line;
 *  - the market badges carry `rc-market-badge` (the class that opts them out
 *    of the REEA-1096 ellipsis rule) and a `title` holding the full label as
 *    a fallback;
 *  - a Kuwait-only row stays untouched.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

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

const SAR_OFFER: PriceOffer = {
  merchant: "Danube Home",
  price: 5.8,
  currency: "SAR",
  url: "https://danube.sa/en/products/panadol-24",
  inStock: true,
  collectedAt: "2026-09-08T00:00:00.000Z",
};
const KW_OFFER: PriceOffer = {
  merchant: "Xcite",
  price: 0.9,
  currency: "KWD",
  url: "https://xcite.example/p",
  inStock: true,
  collectedAt: "2026-09-08T00:00:00.000Z",
};

function card(offers: PriceOffer[]): NormalizedProduct {
  return {
    productId: "panadol-24",
    title: "Panadol Pain Relief 24 Tablets",
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-08T00:00:00.000Z",
  };
}

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("REEA-1161 — market badges keep their full label", () => {
  it("marks a cross-market row and carries the full EN label in the title", () => {
    const { container } = render(<ProductResultCard product={card([SAR_OFFER])} rank={0} />);
    const row = container.querySelector(".offer-row") as HTMLElement;
    expect(row.classList.contains("has-market")).toBe(true);
    const badges = Array.from(container.querySelectorAll(".rc-market-badge")) as HTMLElement[];
    expect(badges.map((b) => text(b))).toEqual(["Saudi price", "KSA stock"]);
    for (const badge of badges) {
      expect(badge.getAttribute("title")).toBe(text(badge));
      // The 375 ellipsis rule targets `.label-token`; the badge must not also
      // pin `whitespace-nowrap`, so the CSS can keep the full text.
      expect(badge.className).not.toContain("whitespace-nowrap");
    }
  });

  it("carries the full AR labels and titles", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} rank={0} locale="ar" />,
    );
    const badges = Array.from(container.querySelectorAll(".rc-market-badge")) as HTMLElement[];
    expect(badges.map((b) => text(b))).toEqual(["سعر السعودية", "مخزون السعودية"]);
    for (const badge of badges) {
      expect(badge.getAttribute("title")).toBe(text(badge));
    }
  });

  it("leaves a Kuwait-only row unmarked", () => {
    const { container } = render(<ProductResultCard product={card([KW_OFFER])} rank={0} />);
    const row = container.querySelector(".offer-row") as HTMLElement;
    expect(row.classList.contains("has-market")).toBe(false);
    expect(container.querySelectorAll(".rc-market-badge")).toHaveLength(0);
  });
});
