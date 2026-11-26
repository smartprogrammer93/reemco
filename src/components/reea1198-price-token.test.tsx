// @vitest-environment jsdom
/**
 * REEA-1198 — the disclosed-fallback price token must not split.
 *
 * Live defect (served head 76b8da1, 375 AR, `/results?q=panadol&market=KW`):
 * the honest headline rendered `لا يوجد عرض في الكويت · سعر السعودية من KD` /
 * `0.47` — the currency code and the amount broke across two lines, which
 * reads as a broken figure on the exact fallback path 6d introduced.
 *
 * These pins assert the render contract that makes the fix real:
 *  - the headline is split into its sentence and its price, and the price is
 *    its own `.rc-price-token` span (the sentence still wraps around it);
 *  - the headline text is unchanged for the reader (same sentence string);
 *  - the hero and offer-row price spans keep the figure in one `.price-cur`
 *    token, and the `≈KD 0.47` conversion stamp stays in `.price-alt`;
 *  - the stylesheet carries `white-space: nowrap` for those tokens.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
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

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ");

describe("REEA-1198 — the fallback price token is one unbroken figure (375 AR)", () => {
  it("splits the AR headline so KD 0.47 is its own nowrap token", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} locale="ar" />,
    );
    const headline = container.querySelector(".rc-market-headline bdi");
    expect(headline).not.toBeNull();
    // The reader still gets the exact honest sentence, character for character.
    expect(text(headline)).toBe("لا يوجد عرض في الكويت · سعر السعودية من KD 0.47");
    const token = headline?.querySelector(".rc-price-token");
    expect(token).not.toBeNull();
    expect(text(token)).toBe("KD 0.47");
    // The sentence is NOT inside the token: only the figure is nowrap.
    expect(text(token)).not.toContain("سعر السعودية");
  });

  it("keeps the EN headline sentence intact around the split token", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} locale="en" />,
    );
    const headline = container.querySelector(".rc-market-headline bdi");
    expect(text(headline)).toBe("No Kuwait offer · Saudi price from KD 0.47");
    expect(text(headline?.querySelector(".rc-price-token"))).toBe("KD 0.47");
  });

  it("the hero price and the ≈KD conversion stamp stay inside their price tokens", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} locale="ar" />,
    );
    const hero = container.querySelector(".rc-price-line .price-cur");
    expect(hero).not.toBeNull();
    expect(text(hero)).toContain("SAR 5.80");
    const alt = container.querySelector(".rc-price-line .price-alt");
    expect(text(alt)).toBe("· ≈KD 0.47");
    expect(text(alt?.querySelector("bdi"))).toBe("≈KD 0.47");
  });

  it("the offer-row price and ≈KD stamp are the same single tokens", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} locale="ar" />,
    );
    const rowPrice = container.querySelector(".rc-offer-row .rc-price-block .price-cur");
    expect(text(rowPrice)).toBe("SAR 5.80");
    const rowAlt = container.querySelector(".rc-offer-row .rc-price-meta .price-alt bdi");
    expect(text(rowAlt)).toBe("≈KD 0.47");
  });

  it("the disclosure repetition of the headline carries the same token split", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} locale="ar" />,
    );
    const bodies = Array.from(container.querySelectorAll("p")).filter((p) =>
      (p.textContent ?? "").includes("لا يوجد عرض في الكويت"),
    );
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const p of bodies) {
      expect(text(p.querySelector(".rc-price-token"))).toBe("KD 0.47");
    }
  });

  it("the stylesheet keeps the price tokens non-breaking", () => {
    const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    const rule = css.match(/\.rc-price-token,\s*\.price-cur\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain("white-space: nowrap");
  });
});
