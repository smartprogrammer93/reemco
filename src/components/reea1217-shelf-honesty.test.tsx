// @vitest-environment jsdom
/**
 * REEA-1217 items 1–3 — shelf-card honesty residuals on served `14819423`.
 *
 *  1. AR `fold 7` / `samsung-galaxy-z-fold7-256gb`: a first-stage Saudi-only
 *     card claimed "No Kuwait offer · Saudi price from KD 628.24" while
 *     "Checking Kuwait stores…" was on screen; its own PDP resolved three
 *     Kuwait retailers.
 *  2. EN `headphones` / `belkin-rockstar-c`: the basis read "0 retailers"
 *     over one rendered Xcite row (KD 2.90) because the single row was a
 *     possible-mismatch offer (zero comparison lanes).
 *  3. EN `iphone 17 pro` / `apple-iphone17-pro-256gb`: the headline was Wibi
 *     KD 314.90 but the three-row cap printed Xcite/Eureka only — the best
 *     merchant was absent from the card's own list.
 *
 * The pins are shopper-visible: no false absence claim while the batch may
 * still land, a basis that agrees with the rendered rows, and the headline's
 * merchant inside the list the card prints.
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

const text = (el: Element) => (el.textContent ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ");

function product(productId: string, title: string, offers: PriceOffer[]): NormalizedProduct {
  return {
    productId,
    title,
    brand: "Test",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-26T09:17:50.630Z",
  };
}

const SAUDI_ONLY: PriceOffer = {
  merchant: "Jarir",
  price: 6699,
  currency: "SAR",
  url: "https://www.jarir.example/fold7",
  inStock: true,
};

describe("REEA-1217 item 1 — no false 'No Kuwait offer' while the batch is pending", () => {
  it("EN: a pending cross-market-only card states the foreign price it holds", () => {
    const { container } = render(
      <ProductResultCard
        product={product("fold7", "Samsung Galaxy Z Fold7", [SAUDI_ONLY])}
        isBest
        kuwaitBatchPending
        kuwaitPendingStatus
        query="fold 7"
        rank={0}
        locale="en"
      />,
    );
    const body = text(container);
    expect(body).toContain("Saudi price from KD 546.64");
    expect(body).not.toContain("No Kuwait offer");
  });

  it("AR: the pending headline keeps the absence claim off screen", () => {
    const { container } = render(
      <ProductResultCard
        product={product("fold7", "Samsung Galaxy Z Fold7", [SAUDI_ONLY])}
        isBest
        kuwaitBatchPending
        kuwaitPendingStatus
        query="fold 7"
        rank={0}
        locale="ar"
      />,
    );
    const body = text(container);
    expect(body).toContain("سعر السعودية من KD 546.64");
    expect(body).not.toContain("لا يوجد عرض في");
  });

  it("the settled card keeps the full disclosure (the batch answered)", () => {
    const { container } = render(
      <ProductResultCard
        product={product("fold7", "Samsung Galaxy Z Fold7", [SAUDI_ONLY])}
        isBest
        kuwaitBatchPending={false}
        kuwaitPendingStatus={false}
        query="fold 7"
        rank={0}
        locale="en"
      />,
    );
    expect(text(container)).toContain("No Kuwait offer · Saudi price from KD 546.64");
  });
});

describe("REEA-1217 item 2 — the basis line agrees with the rows the card renders", () => {
  it("one possible-mismatch row reads '1 retailer', never '0 retailers'", () => {
    // Live shape: the Belkin Rockstar card's only in-market offer sat below the
    // possible-mismatch ratio, so the comparison-lane count was 0 while the
    // row still rendered KD 2.90.
    const belkin: PriceOffer = {
      merchant: "Xcite",
      price: 2.9,
      currency: "KWD",
      url: "https://www.xcite.com/belkin-rockstar-headphones-with-usb-c-connector-white/p",
      inStock: true,
      wasPrice: 5.5,
      sanity: { status: "ok", ratioToMedian: 0.05 },
    };
    const { container } = render(
      <ProductResultCard
        product={product("belkin-rockstar-c", "Belkin Rockstar Headphones with USB-C Connector - White", [belkin])}
        query="headphones"
        rank={1}
        locale="en"
      />,
    );
    const body = text(container);
    expect(container.querySelector(".rc-card-basis")?.textContent).toBe("1 retailer");
    expect(container.querySelectorAll("li.offer-row")).toHaveLength(1);
    expect(body).toContain("KD 2.90");
    expect(body).not.toContain("0 retailers");
  });

  it("a card with no rows still reads '0 retailers'", () => {
    const { container } = render(
      <ProductResultCard
        product={product("empty", "Empty product", [])}
        query="headphones"
        rank={1}
        locale="en"
      />,
    );
    expect(container.querySelector(".rc-card-basis")?.textContent).toBe("0 retailers");
  });
});

describe("REEA-1217 item 3 — the headline's merchant appears in its own list", () => {
  // Live shape: Wibi's KD 314.90 was the cheapest in-market offer but came
  // from the last-seen snapshot, so the live-first ladder sorted it below the
  // three-row cap; the card headlined Wibi while printing Xcite/Eureka only.
  const WIBI: PriceOffer = {
    merchant: "Wibi",
    price: 314.9,
    currency: "KWD",
    url: "https://wibi.com.kw/products/apple-iphone-17-pro-256gb",
    inStock: true,
    label: "Middle East Version",
    fromSnapshot: true,
    wasPrice: 365,
  };
  const LIVE_ROWS: PriceOffer[] = [
    { merchant: "Eureka", price: 331.9, currency: "KWD", url: "https://www.eureka.com.kw/products/details/275096", inStock: true, label: "American Version" },
    { merchant: "Eureka", price: 331.9, currency: "KWD", url: "https://www.eureka.com.kw/products/details/274951", inStock: true, label: "Japanese VR" },
    { merchant: "Xcite", price: 333.9, currency: "KWD", url: "https://www.xcite.com/apple-iphone-17-pro/p", inStock: true },
    { merchant: "Blink", price: 350, currency: "KWD", url: "https://blink.example/iphone-17-pro", inStock: true, label: "eSIM" },
  ];

  it("pins the headline row when the live-first cap would omit it", () => {
    const { container } = render(
      <ProductResultCard
        product={product("apple-iphone17-pro-256gb", "Apple iPhone 17 Pro 256Gb Silver", [WIBI, ...LIVE_ROWS])}
        isBest
        query="iphone 17 pro"
        rank={0}
        locale="en"
      />,
    );
    const hero = container.querySelector(".rc-price-card");
    expect(text(hero as Element)).toContain("KD 314.90");
    const rows = [...container.querySelectorAll("li.offer-row .rc-retailer-name")].map((el) => text(el));
    expect(rows[0]).toBe("Wibi");
    expect(rows).toContain("Wibi");
    // The card still points at the full live set for the rest.
    expect(text(container)).toContain("View all 5 offers");
  });

  it("leaves the normal ordering untouched when the headline is already in the cap", () => {
    const { container } = render(
      <ProductResultCard
        product={product("apple-iphone17-pro-256gb", "Apple iPhone 17 Pro 256Gb Silver", [...LIVE_ROWS])}
        isBest
        query="iphone 17 pro"
        rank={0}
        locale="en"
      />,
    );
    const rows = [...container.querySelectorAll("li.offer-row .rc-retailer-name")].map((el) => text(el));
    expect(rows[0]).toBe("Eureka");
    expect(rows).toHaveLength(3);
  });
});
