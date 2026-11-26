/**
 * REEA-1192 — the PDP inherits the shelf collection's offer set.
 *
 * Live defect on `76b8da1`: every PDP sampled rendered "1 retailer answered"
 * and "All offers · 1 retailers" while its own payload carried the card's
 * 4–7 KW offers, because the hero/table/counts were built from the partial
 * live job only. These pins hold the conversion page to the clicked card's
 * set: inherited rows render, a live re-check replaces its own row, the
 * count lines agree with the table, and the pending skeleton never prints
 * the `{n}` placeholder as an ellipsis.
 */
// @vitest-environment jsdom
import { Suspense, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductHero from "@/components/ProductHero";
import { mergeInheritedOfferRows } from "@/lib/offer-rows";
import { resetSessionCacheForTests } from "@/lib/collect/useCollection";
import type { CollectJob, LiveOffer } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";

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

const PRODUCT_ID = "apple-iphone17-pro-256gb";
const STAMP = new Date(Date.now() - 42_000).toISOString();

function offer(merchant: string, price: number, url: string, collectedAt = STAMP): LiveOffer {
  return {
    merchant,
    domain: `${merchant.toLowerCase().replace(/\s+/g, "")}.com.kw`,
    price,
    currency: "KWD",
    url,
    inStock: true,
    collectedAt,
    collectedAtEpochMs: Date.parse(collectedAt),
    method: "live",
  };
}

/** The card the shopper clicked: 4 KW merchants, best 314.90 Wibi. */
const cardOffers: LiveOffer[] = [
  offer("Wibi", 314.9, "https://wibi.com.kw/apple-iphone-17-pro-256gb"),
  offer("Xcite", 319.9, "https://www.xcite.com/apple-iphone-17-pro-256gb"),
  offer("Eureka", 331.9, "https://www.eureka.com.kw/details/275096"),
  offer("Blink", 350, "https://blink.com.kw/apple-iphone-17-pro"),
];

function product(offers: LiveOffer[] = cardOffers): NormalizedProduct {
  return {
    productId: PRODUCT_ID,
    title: "Apple iPhone 17 Pro 256Gb Silver",
    brand: "Apple",
    offers: offers as unknown as NormalizedProduct["offers"],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function job(offers: LiveOffer[], status: CollectJob["status"] = "complete"): CollectJob {
  return {
    jobId: "job-reea1192",
    productId: PRODUCT_ID,
    status,
    mode: "live",
    startedAt: STAMP,
    finishedAt: status === "complete" ? STAMP : undefined,
    subtasks: [
      { retailer: "Wibi", domain: "wibi.com.kw", status: "done", offersFound: 1 },
      { retailer: "Xcite", domain: "xcite.com", status: "failed", offersFound: 0 },
      { retailer: "Eureka", domain: "eureka.com.kw", status: "failed", offersFound: 0 },
      { retailer: "Blink", domain: "blink.com.kw", status: "failed", offersFound: 0 },
    ],
    offers,
  };
}

async function renderHero(p: NormalizedProduct, j: CollectJob): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    const result = render(
      <Suspense fallback={null}>
        <ProductHero product={p} locale="en" firstStage={Promise.resolve(j)} />
      </Suspense>,
    );
    container = result.container;
  });
  return container;
}

describe("REEA-1192 — PDP inherits the shelf offer set", () => {
  it("merges inherited rows with live re-checks and keeps a live row's own price", () => {
    const live = [offer("Wibi", 312.5, "https://wibi.com.kw/apple-iphone-17-pro-256gb")];
    const merged = mergeInheritedOfferRows(cardOffers, live);
    expect(merged).toHaveLength(4);
    expect(merged.find((o) => o.merchant === "Wibi")?.price).toBe(312.5);
    // Every other inherited merchant survives a failed re-check.
    expect(merged.map((o) => o.merchant)).toEqual(["Wibi", "Xcite", "Eureka", "Blink"]);
  });

  it("does not inherit a catalog seed that has no collection stamp", () => {
    const seeded = { ...offer("Xcite", 47.9, "https://xcite.com/x"), collectedAt: undefined };
    const merged = mergeInheritedOfferRows([seeded as unknown as LiveOffer], []);
    expect(merged).toHaveLength(0);
  });

  it("renders the card's 4 retailers and best price even when only one lane answered", async () => {
    const container = await renderHero(
      product(),
      job([offer("Wibi", 314.9, "https://wibi.com.kw/apple-iphone-17-pro-256gb")]),
    );
    const heading = container.querySelector(".rc-offers-table h2");
    expect(heading?.textContent).toBe("All offers · 4 retailers");
    const rows = container.querySelectorAll(".rc-offers-table .rc-offer-row");
    expect(rows).toHaveLength(4);
    const retailers = [...rows].map(
      (r) => r.querySelector(".rc-retailer-name")?.textContent?.trim() ?? "",
    );
    expect(retailers).toEqual(["Wibi", "Xcite", "Eureka", "Blink"]);
    // Δ = 0 with the clicked card: the hero leads on the card's best price.
    expect(container.querySelector(".rc-product-price")?.textContent).toContain("314.90");
    // The two count lines cannot disagree.
    expect(container.textContent).toContain("4 retailers answered");
    // A lane that failed but still renders is not reported as missing.
    expect(container.textContent).not.toContain("Xcite،");
  });

  it("never prints the `{n}` placeholder while the live run is still starting", async () => {
    const container = await renderHero(product([]), job([], "collecting"));
    expect(container.textContent).not.toContain("… retailers");
    expect(container.querySelector(".rc-offers-table h2")?.textContent).toBe("All offers");
  });
});
