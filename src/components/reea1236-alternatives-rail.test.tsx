// @vitest-environment jsdom
/**
 * REEA-1236 — render-side coverage for the alternatives rail unit fix.
 *
 * Live defect on `bfac72c7f523` (`/results?q=iphone+15`, EN): card
 * `apple-iphone15-pro-128gb` painted "Saudi price from KD 383.44" and its
 * Alternatives rail painted "from KD 3,279" for the SAR 3,279 listing
 * (`apple-iphone15-128gb`) — the rail overstated by 12.3x.
 *
 * Checks:
 *  1. Results rail: a SAR-sourced alternative prints "from ≈KD 267.57"
 *     (AC2), never "from KD 3,279".
 *  2. Detail variant of the same card carries the identical figure.
 *  3. AC4: a leaked raw figure above 3x the card's lead is demoted to the
 *     offer's own currency — no KD label on a native amount.
 *  4. AR: the figure rides the localized "ابتداءً من" lead inside the <bdi>,
 *     RTL preserved, no overflow-prone long token.
 *  5. KWD-native entries keep the bare "KD 6.45" form.
 *  6. PDP: the hero rail shares the contract — a SAR alternative prints
 *     "≈KD 267.57", never the raw 3,279.
 */
import { Suspense, act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import ProductHero from "@/components/ProductHero";
import { resetSessionCacheForTests } from "@/lib/collect/useCollection";
import type { NormalizedProduct, ProductAlternative } from "@/types/product";

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

const SAR_3279_KWD = 3279 * 0.0816; // ≈KD 267.57

function card(alternatives: ProductAlternative[]): NormalizedProduct {
  return {
    productId: "apple-iphone15-pro-128gb",
    title: "Apple iPhone 15 Pro",
    brand: "Apple",
    offers: [
      {
        merchant: "Jarir",
        price: 4699,
        currency: "SAR",
        url: "https://jarir.example/iphone15pro",
        inStock: true,
        market: "SA",
      },
    ],
    coupons: [],
    variations: [],
    alternatives,
    scrapedAt: "2026-11-27T12:05:44.000Z",
    scrapedAtEpochMs: Date.parse("2026-11-27T12:05:44.000Z"),
  };
}

const corrected: ProductAlternative[] = [
  {
    productId: "apple-iphone15-128gb",
    title: "Apple iPhone 15, 128 Apple A16 Bionic",
    fromPrice: SAR_3279_KWD,
    fromCurrency: "SAR",
    fromNativePrice: 3279,
  },
];

function railText(container: HTMLElement): string {
  const section = container.querySelector('section[aria-label="Alternatives"]');
  return section?.textContent ?? "";
}

describe("REEA-1236 — results Alternatives rail renders the converted figure", () => {
  it("EN: SAR alternative prints from ≈KD 267.57, never KD 3,279", () => {
    const { container } = render(
      <ProductResultCard product={card(corrected)} query="iphone 15" rank={0} locale="en" />,
    );
    const text = railText(container);
    expect(text).toContain("from ≈KD 267.57");
    expect(text).not.toContain("KD 3,279");
  });

  it("detail variant prints the identical converted figure", () => {
    const { container } = render(
      <ProductResultCard
        product={card(corrected)}
        query="iphone 15"
        rank={0}
        locale="en"
        variant="detail"
      />,
    );
    const text = railText(container);
    expect(text).toContain("from ≈KD 267.57");
    expect(text).not.toContain("KD 3,279");
  });

  it("AR: localized lead with the same converted figure inside a bdi", () => {
    const { container } = render(
      <ProductResultCard product={card(corrected)} query="آيفون 15" rank={0} locale="ar" />,
    );
    const section = container.querySelector('section[aria-label="بدائل"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("ابتداءً من ≈KD 267.57");
    expect(section!.querySelector("bdi")).not.toBeNull();
  });

  it("AC4: a leaked raw 3,279 figure is demoted to SAR, not printed as KD", () => {
    const leaked: ProductAlternative[] = [
      { ...corrected[0], fromPrice: 3279, fromNativePrice: 3279 },
    ];
    const { container } = render(
      <ProductResultCard product={card(leaked)} query="iphone 15" rank={0} locale="en" />,
    );
    const text = railText(container);
    expect(text).toContain("from SAR 3,279.00");
    expect(text).not.toContain("KD 3,279");
  });

  it("KWD-native alternatives keep the bare KD form", () => {
    const { container } = render(
      <ProductResultCard
        product={card([
          {
            productId: "case",
            title: "Silicone Case",
            fromPrice: 6.45,
            fromCurrency: "KWD",
          },
        ])}
        query="iphone 15"
        rank={0}
        locale="en"
      />,
    );
    expect(railText(container)).toContain("from KD 6.45");
  });
});

describe("REEA-1236 — PDP hero rail shares the same contract", () => {
  it("EN: SAR alternative prints from ≈KD 267.57, never KD 3,279", async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ProductHero
            product={card(corrected)}
            country="KW"
            locale="en"
            query="iphone 15"
            renderStartMs={Date.parse("2026-11-27T12:05:44.000Z")}
          />
        </Suspense>,
      );
    });
    const section = document.querySelector('section[aria-label="Alternatives"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("from ≈KD 267.57");
    expect(section!.textContent).not.toContain("KD 3,279");
    expect(screen.getByText("Apple iPhone 15, 128 Apple A16 Bionic")).toBeTruthy();
  });
});
