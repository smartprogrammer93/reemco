// @vitest-environment jsdom
/**
 * REEA-963 R1 — render-side coverage for the sanity flags.
 * FR-1.3: flagged offers render the visible "price needs verification"
 * affordance (with the reason in the title attribute) and stay visible.
 * FR-1.4: flagged offers are excluded from the "from KD X" rollup, the
 * lowest-listed chip and the Best-price claim. E3: a price-unavailable
 * offer renders the honest state, never "KD 0". FR-3.3: an all-flagged
 * variant family renders the warning state instead of a price.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import { bestBadgeIndex } from "@/lib/stock";
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

function offer(over: Partial<PriceOffer>): PriceOffer {
  return {
    merchant: "Xcite",
    price: 300,
    currency: "KWD",
    url: "https://xcite.example/p",
    inStock: true,
    ...over,
  };
}

function product(offers: PriceOffer[], variations: NormalizedProduct["variations"] = []): NormalizedProduct {
  return {
    productId: "p1",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers,
    coupons: [],
    variations,
    alternatives: [],
    scrapedAt: "2026-09-14T00:00:00.000Z",
  };
}

const FLAGGED_LOW: PriceOffer = offer({
  merchant: "Eureka",
  price: 2,
  url: "https://eureka.example/p",
  sanity: { status: "flagged", reason: "outlier_low", ratioToMedian: 0.007 },
});
const OK_LEAD: PriceOffer = offer({ merchant: "Jarir", price: 40, currency: "KWD", url: "https://jarir.example/p" });
const NO_PRICE: PriceOffer = offer({
  merchant: "Blink",
  price: 0,
  url: "https://blink.example/p",
  sanity: { status: "flagged", reason: "price_unavailable" },
});

describe("REEA-963 FR-1.3 — the warning affordance", () => {
  it("flagged hero renders the badge with the reason sentence, figure stays visible", () => {
    const { container } = render(
      <ProductResultCard product={product([FLAGGED_LOW, OK_LEAD])} query="iphone 17 pro" rank={0} />,
    );
    const warns = container.querySelectorAll(".price-warn");
    expect(warns.length).toBeGreaterThanOrEqual(1); // hero + its row
    expect((warns[0] as HTMLElement).getAttribute("title")).toContain("typical price");
    expect(container.textContent).toContain("KD 2"); // flagged figure stays visible
    expect(container.textContent).toContain("Price needs verification");
  });

  it("a clean card renders no warning affordance at all", () => {
    const { container } = render(
      <ProductResultCard product={product([OK_LEAD])} query="iphone 17 pro" rank={0} />,
    );
    expect(container.querySelectorAll(".price-warn")).toHaveLength(0);
  });
});

describe("REEA-963 FR-1.4 — flagged offers are excluded from claims and rollups", () => {
  it("the from-rollup reads non-flagged offers only (KD 40, not the flagged KD 2)", () => {
    const { container } = render(
      <ProductResultCard product={product([FLAGGED_LOW, OK_LEAD])} query="iphone 17 pro" rank={0} />,
    );
    const fromLine = Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.includes("from"));
    expect(fromLine?.textContent).toContain("KD 40");
    expect(fromLine?.textContent).not.toContain("KD 2");
  });

  it("a flagged lead offer never wears the Best-price flag nor the lowest chip", () => {
    const { container } = render(
      <ProductResultCard product={product([FLAGGED_LOW, OK_LEAD])} isBest query="iphone 17 pro" rank={0} />,
    );
    expect(container.textContent).not.toContain("Best price");
    for (const el of container.querySelectorAll(".label-token")) {
      expect(el.textContent).not.toContain("Lowest listed price");
    }
  });

  it("bestBadgeIndex skips all-flagged cards and suppresses when the whole list is flagged", () => {
    const flaggedCard = product([FLAGGED_LOW]);
    const okCard = product([OK_LEAD]);
    expect(bestBadgeIndex([flaggedCard, okCard])).toBe(1);
    expect(bestBadgeIndex([flaggedCard])).toBe(-1); // claim suppressed, not faked
    // zero-stock fallback keeps the old first-card rule
    const oosCard = product([offer({ inStock: false })]);
    expect(bestBadgeIndex([oosCard])).toBe(0);
  });
});

describe("REEA-963 E3 — the price-unavailable state", () => {
  it("renders 'Price unavailable', never KD 0, on hero and row", () => {
    const { container } = render(
      <ProductResultCard product={product([NO_PRICE, OK_LEAD])} query="iphone 17 pro" rank={0} />,
    );
    expect(container.textContent).toContain("Price unavailable");
    expect(container.textContent).not.toContain("KD 0");
    // The unavailable state IS the affordance: no extra warning chip beside it.
    expect(container.querySelectorAll(".price-warn")).toHaveLength(0);
  });
});

describe("REEA-963 FR-3.3 — an all-flagged variant family shows the warning, not a price", () => {
  it("a needsVerification variation chip renders the warning and no figure", () => {
    const { container } = render(
      <ProductResultCard
        product={product([OK_LEAD], [
          { id: "black", label: "Black", priceDelta: 0, needsVerification: true },
          { id: "silver", label: "Silver", priceDelta: 10 },
        ])}
        query="iphone 17 pro"
        rank={0}
      />,
    );
    const chips = Array.from(container.querySelectorAll("section[aria-label] span"));
    const blackChip = chips.find((s) => s.textContent?.startsWith("Black"));
    expect(blackChip?.textContent).toContain("Price needs verification");
    // the healthy color still prints its figure
    const silverChip = chips.find((s) => s.textContent?.startsWith("Silver"));
    expect(silverChip?.textContent).toContain("KD");
  });
});
