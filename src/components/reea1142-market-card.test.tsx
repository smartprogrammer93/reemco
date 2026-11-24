// @vitest-environment jsdom
/**
 * REEA-1142 — render-side pins for the Kuwait market scope.
 *
 * The live defect: a danube.sa SAR offer rendered on the Kuwait surface as
 * `SAR 5.80 · ≈KD 0.47` with an "In stock · Verified" badge and won the
 * "best effective price" headline. These pins assert the accepted policy on
 * the actual shelf card:
 *  - a cross-market row names its market and keeps its own currency beside
 *    the ≈KD reference, and carries "KSA stock" instead of a Kuwait
 *    "Verified" badge;
 *  - a card with a local offer leads with the local price and can badge
 *    "Best price";
 *  - a card with only cross-market offers shows the honest
 *    "No Kuwait offer · Saudi price from KD X" line (EN+AR), never an
 *    unqualified "Best price", and its lead CTA names the market.
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

const KW_OFFER: PriceOffer = {
  merchant: "Xcite",
  price: 0.9,
  currency: "KWD",
  url: "https://xcite.example/p",
  inStock: true,
  collectedAt: "2026-09-08T00:00:00.000Z",
};
const SAR_OFFER: PriceOffer = {
  merchant: "Danube Home",
  price: 5.8,
  currency: "SAR",
  url: "https://danube.sa/en/products/panadol-24",
  inStock: true,
  collectedAt: "2026-09-08T00:00:00.000Z",
};

function card(offers: PriceOffer[], title = "Panadol Pain Relief 24 Tablets"): NormalizedProduct {
  return {
    productId: "panadol-24",
    title,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-08T00:00:00.000Z",
  };
}

const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ");

describe("REEA-1142 AC1 — cross-market rows are labeled", () => {
  it("names the market and keeps the SAR figure beside the ≈KD reference", () => {
    const { container } = render(<ProductResultCard product={card([SAR_OFFER])} rank={0} />);
    const body = text(container);
    expect(body).toContain("Saudi price");
    expect(body).toContain("SAR 5.80");
    expect(body).toContain("≈KD 0.47");
  });

  it("never badges a cross-market row as Kuwait Verified", () => {
    const { container } = render(<ProductResultCard product={card([SAR_OFFER])} rank={0} />);
    const rows = Array.from(container.querySelectorAll(".offer-row"));
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(text(row)).toContain("KSA stock");
    expect(text(row)).not.toContain("Verified");
  });

  it("has the Arabic market label and stock badge", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} rank={0} locale="ar" />,
    );
    const body = text(container);
    expect(body).toContain("سعر السعودية");
    expect(body).toContain("مخزون السعودية");
  });
});

describe("REEA-1142 AC2 — the headline is the local offer", () => {
  it("leads with the KWD price even when the converted SAR offer is cheaper", () => {
    // SAR 5.80 ≈ KD 0.47 is cheaper in KWD-space than Xcite KD 0.90; the
    // Kuwait headline must still be the local KWD offer.
    const { container } = render(
      <ProductResultCard product={card([KW_OFFER, SAR_OFFER])} isBest rank={0} />,
    );
    const body = text(container);
    expect(body).toContain("Best price");
    const hero = container.querySelector(".price-cur");
    expect(text(hero as HTMLElement)).toContain("KD 0.90");
    // The cross-market row still renders, labeled.
    expect(body).toContain("Saudi price");
    expect(body).toContain("SAR 5.80");
  });

  it("renders the honest no-local-offer headline when every offer is cross-market", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} />,
    );
    const body = text(container);
    expect(body).toContain("No Kuwait offer · Saudi price from KD 0.47");
    // An unqualified "Best price" claim is withheld.
    expect(body).not.toContain("Best price");
  });

  it("has the Arabic no-local-offer headline", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} locale="ar" />,
    );
    expect(text(container)).toContain("لا يوجد عرض في الكويت · سعر السعودية من KD 0.47");
  });

  it("the lead CTA names the market instead of claiming a Kuwait best price", () => {
    const { container } = render(
      <ProductResultCard product={card([SAR_OFFER])} isBest rank={0} />,
    );
    const cta = container.querySelector(".cta-lead");
    expect(cta).not.toBeNull();
    const ctaText = text(cta as HTMLElement);
    expect(ctaText).toContain("Saudi price KD 0.47");
    expect(ctaText).not.toContain("Best effective price");
  });
});
