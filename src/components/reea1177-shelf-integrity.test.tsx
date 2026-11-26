// @vitest-environment jsdom
/**
 * REEA-1177 (Bet 6a+6d) — shopper-facing pins for the shelf integrity fix:
 * one reconciling price statement, derived was-price coupon entries are not
 * coupons, effective-price ordering, Kuwait-first default, the foreign-only
 * exception with its delivery caveat, and the PDP reconciliation.
 */
import { Suspense, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import ProductHero from "@/components/ProductHero";
import { resultsShelfCards } from "@/lib/results-shelf";
import { resetSessionCacheForTests } from "@/lib/collect/useCollection";
import type { CollectJob } from "@/lib/collect/types";
import type { Coupon, NormalizedProduct, PriceOffer } from "@/types/product";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => resetSessionCacheForTests());
afterEach(() => {
  cleanup();
  resetSessionCacheForTests();
});

const text = (el: Element) => (el.textContent ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ");

const XCITE: PriceOffer = {
  merchant: "Xcite",
  price: 319.9,
  currency: "KWD",
  market: "KW",
  url: "https://xcite.example/iphone-17-pro",
  inStock: true,
  wasPrice: 409.9,
  savings: {
    amount: 90,
    struckPrice: 409.9,
    currentPrice: 319.9,
    currency: "KWD",
    baseline: { merchant: "Xcite", listedPrice: 409.9, currency: "KWD", kind: "was_price" },
  },
  collectedAt: "2026-11-25T00:00:00.000Z",
};
const EUREKA: PriceOffer = {
  merchant: "Eureka",
  price: 331.9,
  currency: "KWD",
  market: "KW",
  url: "https://eureka.example/iphone-17-pro",
  inStock: true,
  collectedAt: "2026-11-25T00:00:00.000Z",
};
const DERIVED_COUPON: Coupon = {
  code: null,
  description: "KD 90",
  discount: "KD 90",
  expiresAt: null,
  merchant: "Xcite",
};

function product(offers: PriceOffer[], coupons: Coupon[] = []): NormalizedProduct {
  return {
    productId: "apple-iphone17-pro-256gb",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers,
    coupons,
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-25T00:00:00.000Z",
  };
}

describe("Bet 6a AC1/AC2/AC3 — one reconciling statement, no double-counted coupon", () => {
  it("the Xcite markdown renders one Save statement and no KD 90 coupon badge", () => {
    const { container } = render(
      <ProductResultCard
        product={product([XCITE, EUREKA], [DERIVED_COUPON])}
        isBest
        query="iphone 17 pro"
        rank={0}
        country="KW"
        locale="en"
      />,
    );
    const body = text(container);
    // Headline = effective price.
    expect(container.querySelector(".price-cur")?.textContent).toContain("KD 319.90");
    // Exactly one reconciling composition line: listed − 90 = 319.90.
    const composition = container.querySelector(".rc-price-composition");
    expect(composition).not.toBeNull();
    expect(text(composition as HTMLElement)).toContain("Save KD 90");
    expect(text(composition as HTMLElement)).toContain("Listed KD 409.90");
    expect(text(composition as HTMLElement)).toContain("KD 90 = You pay KD 319.90");
    // The derived coupon entry is the was-price markdown, never a coupon.
    expect(container.querySelectorAll(".coupon-line")).toHaveLength(0);
    expect(container.querySelectorAll(".coupon-badge")).toHaveLength(0);
    expect(body).toContain("No coupon available");
  });

  it("a non-headline Xcite row still states its own was-price saving, without a coupon", () => {
    // The live shape: Wibi KD 314.90 leads, Xcite 409.90/90/319.90 is the
    // second row. The Xcite row reconciles on its own and never adds a
    // "KD 90 coupon" statement.
    const wibi: PriceOffer = {
      merchant: "Wibi",
      price: 314.9,
      currency: "KWD",
      market: "KW",
      url: "https://wibi.example/iphone-17-pro",
      inStock: true,
      collectedAt: "2026-11-25T00:00:00.000Z",
    };
    const { container } = render(
      <ProductResultCard
        product={product([wibi, XCITE], [DERIVED_COUPON])}
        isBest
        query="iphone 17 pro"
        rank={0}
        country="KW"
        locale="en"
      />,
    );
    const xciteRow = Array.from(container.querySelectorAll("li.offer-row")).find((row) =>
      row.textContent?.includes("Xcite"),
    ) as HTMLElement | undefined;
    expect(xciteRow).toBeTruthy();
    expect(text(xciteRow as HTMLElement)).toContain("KD 409.90");
    expect(text(xciteRow as HTMLElement)).toContain("Save KD 90");
    expect(text(xciteRow as HTMLElement)).toContain("KD 319.90");
    expect(container.querySelectorAll(".coupon-badge")).toHaveLength(0);
    expect(container.querySelectorAll(".coupon-line")).toHaveLength(0);
  });

  it("a real coupon states its applied amount and the reconciled effective figure", () => {
    const coupon: Coupon = {
      code: "SAVE10",
      description: "10% off",
      discount: "10% off",
      expiresAt: null,
      merchant: "Xcite",
    };
    const xciteCouponed: PriceOffer = { ...XCITE, price: 314.9, wasPrice: undefined, savings: undefined };
    const { container } = render(
      <ProductResultCard
        product={product([xciteCouponed, EUREKA], [coupon])}
        isBest
        query="iphone 17 pro"
        rank={0}
        country="KW"
        locale="en"
      />,
    );
    const body = text(container);
    expect(container.querySelector(".price-cur")?.textContent).toContain("KD 283.41");
    const composition = container.querySelector(".rc-price-composition");
    expect(text(composition as HTMLElement)).toContain("Coupon KD 31.49 off at checkout");
    expect(text(composition as HTMLElement)).toContain("Listed KD 314.90");
    expect(text(composition as HTMLElement)).toContain("You pay KD 283.41");
    // The coupon drawer line carries the code and the applied amount.
    expect(container.querySelector(".coupon-badge")?.textContent).toBe("SAVE10");
    expect(container.querySelector(".coupon-applied")?.textContent).toContain("KD 31.49");
    expect(container.querySelector(".coupon-effective")?.textContent).toContain("KD 283.41");
    expect(body).not.toContain("No coupon available");
  });
});

describe("Bet 6a AC4 — the primary shelf ranks by effectivePrice", () => {
  it("the first card holds the lowest effective in-market price, not the lowest listed", () => {
    const cheaperListed: NormalizedProduct = {
      productId: "panadol-a",
      title: "Panadol Pain Relief Tablets 24Tablets",
      brand: "",
      offers: [
        {
          merchant: "Sultan Center",
          price: 100,
          currency: "KWD",
          url: "https://sultan.example/a",
          inStock: true,
          effectivePrice: 200,
        },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    };
    const higherListed: NormalizedProduct = {
      productId: "panadol-b",
      title: "Panadol Extra Pain Relief Tablets 24tablets",
      brand: "",
      offers: [
        {
          merchant: "Xcite",
          price: 150,
          currency: "KWD",
          url: "https://xcite.example/b",
          inStock: true,
          effectivePrice: 100,
        },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    };
    const cards = resultsShelfCards(
      { products: [cheaperListed, higherListed] },
      "panadol",
      1,
      "KW",
      false,
    );
    expect(cards.map((p) => p.productId)).toEqual(["panadol-b", "panadol-a"]);
  });
});

describe("Bet 6d AC7 — Kuwait default and the foreign-only exception", () => {
  it("a foreign-currency card is only rendered when it is the product's only offer", () => {
    const sarOnly: PriceOffer = {
      merchant: "Danube Home",
      price: 5.8,
      currency: "SAR",
      market: "SA",
      url: "https://danube.sa/p",
      inStock: true,
      collectedAt: "2026-11-25T00:00:00.000Z",
    };
    const { container } = render(
      <ProductResultCard
        product={product([sarOnly])}
        isBest
        query="panadol"
        rank={0}
        country="KW"
        locale="en"
      />,
    );
    const body = text(container);
    expect(body).toContain("No Kuwait offer · Saudi price from KD 0.47");
    expect(body).toContain("Saudi price");
    expect(body).toContain("SAR 5.80");
    expect(body).toContain("≈KD 0.47");
    expect(body).toContain("Delivery from Saudi Arabia · customs may apply");
    // No unqualified Kuwait "Best price" claim on a foreign-only card.
    expect(container.querySelector(".best-flag")).toBeNull();
  });

  it("a product with a Kuwait offer is KWD-only on the default shelf", () => {
    const sar: PriceOffer = {
      merchant: "Danube Home",
      price: 5.8,
      currency: "SAR",
      market: "SA",
      url: "https://danube.sa/p",
      inStock: true,
    };
    const kw: PriceOffer = {
      merchant: "Xcite",
      price: 0.9,
      currency: "KWD",
      market: "KW",
      url: "https://xcite.example/p",
      inStock: true,
    };
    const { container } = render(
      <ProductResultCard
        product={product([kw, sar])}
        query="panadol"
        rank={0}
        country="KW"
        locale="en"
      />,
    );
    const body = text(container);
    expect(body).toContain("KD 0.90");
    expect(body).not.toContain("SAR 5.80");
    expect(body).not.toContain("Saudi price");
  });
});

describe("Bet 6a AC5 — the PDP reconciles listed − saving = price", () => {
  function job(): CollectJob {
    return {
      jobId: "job-reea1177",
      productId: "apple-iphone17-pro-256gb",
      status: "complete",
      mode: "live",
      startedAt: "2026-11-25T00:00:00.000Z",
      finishedAt: "2026-11-25T00:00:00.000Z",
      subtasks: [{ retailer: "Wibi", domain: "wibi.com.kw", status: "done", offersFound: 1 }],
      offers: [
        {
          merchant: "Wibi",
          domain: "wibi.com.kw",
          price: 314.9,
          currency: "KWD",
          url: "https://wibi.com.kw/p",
          inStock: true,
          wasPrice: 365,
          collectedAt: "2026-11-25T00:00:00.000Z",
          collectedAtEpochMs: Date.parse("2026-11-25T00:00:00.000Z"),
          method: "live",
        },
      ],
    };
  }

  it("renders one reconciling line and drops the contradictory KD 90 coupon", async () => {
    const p: NormalizedProduct = {
      ...product([]),
      coupons: [
        { code: null, description: "KD 90", discount: "KD 90", expiresAt: null, merchant: "Xcite" },
      ],
    };
    let container!: HTMLElement;
    await act(async () => {
      const result = render(
        <Suspense fallback={null}>
          <ProductHero
            product={p}
            country="KW"
            locale="en"
            firstStage={Promise.resolve(job())}
          />
        </Suspense>,
      );
      container = result.container;
    });
    const body = text(container);
    expect(body).toContain("Listed KD 365");
    expect(body).toContain("KD 50.10 = You pay KD 314.90");
    expect(body).toContain("Save KD 50.10");
    expect(body).not.toContain("coupon applied at checkout");
  });
});
