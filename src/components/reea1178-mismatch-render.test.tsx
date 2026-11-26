// @vitest-environment jsdom
/**
 * REEA-1178 AC2/AC3/AC4 — render-side coverage for the integrity change.
 *
 * Live evidence this pins (served head `fb1747d2`):
 *  - the Anker AeroFit 2 card carried an Amazon.eg accessory at EGP 245,
 *    ratioToMedian 0.09997 and sanity `ok` (the collector's cohort bound is
 *    15×, so the flag alone did not catch it) — it counted as a comparison
 *    retailer on the earbuds card;
 *  - two Eureka 1TB listings at KD 489.90 rendered with only one label, so the
 *    regional versions were indistinguishable.
 *
 * The assertions are the shopper-visible outcome: the accessory row stays
 * visible with its own price and a "Possible mismatch" marker, it does not
 * add a retailer to the card, and same-price twins are distinguishable.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import { distinguishSamePriceRows } from "@/lib/offer-integrity";
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

function product(offers: PriceOffer[]): NormalizedProduct {
  return {
    productId: "p1",
    title: "Soundcore AeroFit 2 Open-Ear Wireless Earbuds - Anker",
    brand: "Anker",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T00:00:00.000Z",
  };
}

describe("REEA-1178 AC3 — a possible mismatch is visible but not a comparison lane", () => {
  it("marks the low-ratio accessory, keeps the count at one and never leads with its price", () => {
    // In-market accessory at ratioToMedian 0.05 and sanity `ok` — the shape of
    // the live Anker/Amazon.eg offer (0.09997, `ok` under the 15× bound), kept
    // in-market here because a market-scoped shelf (REEA-1177 AC 6d-3) renders
    // only that market's rows.
    const accessory = offer({
      merchant: "Xcite",
      price: 2.9,
      url: "https://xcite.example/aerofit-case",
      sanity: { status: "ok", ratioToMedian: 0.05 },
    });
    const earbuds = offer({ merchant: "Switch", price: 22.99, url: "https://switch.example/aerofit" });
    const { container, getByText } = render(
      <ProductResultCard product={product([accessory, earbuds])} rank={1} locale="en" />,
    );
    expect(getByText("Possible mismatch")).toBeTruthy();
    // The accessory row keeps its own price, never hidden.
    expect(container.textContent).toContain("KD 2.90");
    // The headline is the card's own product, not the accessory's figure.
    expect(container.textContent).toContain("KD 22.99");
    // One retailer: the accessory did not become a second comparison lane.
    expect(container.textContent).toContain("1 retailer");
    expect(container.textContent).not.toContain("2 retailers");
  });

  it("does not mark a high outlier — fold 7's phones stay a comparison", () => {
    const phoneA = offer({
      merchant: "Xcite",
      price: 379.9,
      url: "https://xcite.example/fold7",
      sanity: { status: "flagged", reason: "outlier_high", ratioToMedian: 64.7 },
    });
    const phoneB = offer({
      merchant: "Blink",
      price: 385,
      url: "https://blink.example/fold7",
      sanity: { status: "flagged", reason: "outlier_high", ratioToMedian: 65.6 },
    });
    const { container, queryByText } = render(
      <ProductResultCard product={product([phoneA, phoneB])} rank={1} locale="en" />,
    );
    expect(queryByText("Possible mismatch")).toBeNull();
    // Two clean in-market lanes keep the comparison claim (REEA-1177's basis
    // line reads "best effective price" once the claim is earned).
    expect(container.textContent).toContain("best effective price");
  });
});

describe("REEA-1178 AC4 — same-price rows are distinguishable on the card", () => {
  it("renders both labels of two same-price Eureka listings", () => {
    const rows = distinguishSamePriceRows([
      offer({ merchant: "Eureka", price: 489.9, url: "https://www.eureka.com.kw/products/details/276369", label: "Japanese VR" }),
      offer({ merchant: "Eureka", price: 489.9, url: "https://www.eureka.com.kw/products/details/267450" }),
      offer({ merchant: "Jarir", price: 7199, currency: "SAR", url: "https://www.jarir.com/p-666740.html", label: "A19" }),
    ]);
    const { container } = render(<ProductResultCard product={product(rows)} rank={1} locale="en" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Japanese VR");
    expect(text).toContain("#267450");
  });
});
