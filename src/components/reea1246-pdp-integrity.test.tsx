/**
 * REEA-1246 (Bet 7) — the PDP's first paint must not be worse than the click.
 *
 * These pins render the real hero with the clicked card's rows already in the
 * payload (the seed path) and assert the three shopper-visible claims:
 *  - the headline is the card's best price (not a later partial fan-out);
 *  - an out-of-stock-only set is labelled "Out of stock — price reference",
 *    never presented as an unqualified best price;
 *  - while the page's own re-check is still running the figure is explicitly
 *    provisional, and the label disappears once the run converges.
 */
// @vitest-environment jsdom
import { Suspense, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductHero from "@/components/ProductHero";
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

function offer(
  merchant: string,
  price: number,
  url: string,
  extra: Partial<LiveOffer> = {},
): LiveOffer {
  return {
    merchant,
    domain: `${merchant.toLowerCase().replace(/\s+/g, "")}.com.kw`,
    price,
    currency: "KWD",
    url,
    inStock: true,
    collectedAt: STAMP,
    collectedAtEpochMs: Date.parse(STAMP),
    method: "cache",
    ...extra,
  };
}

/** The card the shopper clicked: Wibi 314.90 is the click promise. */
const clickedOffers: LiveOffer[] = [
  offer("Wibi", 314.9, "https://wibi.com.kw/apple-iphone-17-pro-256gb", {
    wasPrice: 365,
  }),
  offer("Yousifi", 317.9, "https://best.com.kw/iphone-17-pro"),
  offer("Eureka", 331.9, "https://www.eureka.com.kw/details/275096"),
  offer("Xcite", 333.9, "https://www.xcite.com/apple-iphone-17-pro/p"),
];

function product(offers: LiveOffer[] = clickedOffers): NormalizedProduct {
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

function job(
  offers: LiveOffer[],
  status: CollectJob["status"],
  subtasks: CollectJob["subtasks"],
): CollectJob {
  return {
    jobId: "job-reea1246",
    productId: PRODUCT_ID,
    status,
    mode: "live",
    startedAt: STAMP,
    finishedAt: status === "complete" ? STAMP : undefined,
    subtasks,
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

describe("REEA-1246 AC1 — the clicked price leads the first paint", () => {
  it("prints the card's best price, not a later partial fan-out", async () => {
    // The page's own re-check has only Eureka (331.90) so far — the old defect.
    const container = await renderHero(
      product(),
      job(
        [offer("Eureka", 331.9, "https://www.eureka.com.kw/details/275096")],
        "collecting",
        [
          { retailer: "Wibi", domain: "wibi.com.kw", status: "collecting", offersFound: 0 },
          { retailer: "Eureka", domain: "eureka.com.kw", status: "done", offersFound: 1 },
        ],
      ),
    );
    const price = container.querySelector(".rc-product-price")?.textContent ?? "";
    expect(price).toContain("314.90");
    expect(price).not.toContain("331.90");
    // AC1 — until convergence the seeded figure is explicitly provisional.
    expect(container.querySelector(".rc-provisional")?.textContent).toContain(
      "Checking more stores",
    );
  });

  it("drops the provisional label once the page's own run converges", async () => {
    const container = await renderHero(
      product(),
      job(
        [offer("Wibi", 314.9, "https://wibi.com.kw/apple-iphone-17-pro-256gb")],
        "complete",
        [{ retailer: "Wibi", domain: "wibi.com.kw", status: "done", offersFound: 1 }],
      ),
    );
    expect(container.querySelector(".rc-provisional")).toBeNull();
    expect(container.querySelector(".rc-product-price")?.textContent).toContain("314.90");
  });
});

describe("REEA-1246 AC2 — an un-buyable price is never a best price", () => {
  it("labels an out-of-stock-only page as a price reference", async () => {
    const oosOffers = [
      offer("Xcite", 317.21, "https://www.xcite.com/iphone-17-pro/p", { inStock: false }),
      offer("Eureka", 331.9, "https://www.eureka.com.kw/details/275096", { inStock: false }),
    ];
    const container = await renderHero(
      product(oosOffers),
      job([], "complete", [
        { retailer: "Xcite", domain: "xcite.com", status: "done", offersFound: 1 },
        { retailer: "Eureka", domain: "eureka.com.kw", status: "done", offersFound: 1 },
      ]),
    );
    expect(container.querySelector(".price-reference")?.textContent).toContain(
      "Out of stock — price reference",
    );
    // The KWD-only OOS page must not claim a foreign-market caveat.
    expect(container.querySelector(".rc-market-caveat")).toBeNull();
  });

  it("keeps the best-price figure when an in-stock offer is known", async () => {
    const container = await renderHero(
      product(),
      job([], "complete", [
        { retailer: "Wibi", domain: "wibi.com.kw", status: "done", offersFound: 1 },
      ]),
    );
    expect(container.querySelector(".price-reference")).toBeNull();
    expect(container.querySelector(".rc-product-price")?.textContent).toContain("314.90");
  });

  it("does not lead on a cheaper out-of-stock row while an in-stock one is known", async () => {
    const mixed = [
      offer("Xcite", 299, "https://www.xcite.com/iphone-17-pro/p", { inStock: false }),
      offer("Wibi", 314.9, "https://wibi.com.kw/apple-iphone-17-pro-256gb"),
    ];
    const container = await renderHero(
      product(mixed),
      job([], "complete", [
        { retailer: "Xcite", domain: "xcite.com", status: "done", offersFound: 1 },
        { retailer: "Wibi", domain: "wibi.com.kw", status: "done", offersFound: 1 },
      ]),
    );
    expect(container.querySelector(".rc-product-price")?.textContent).toContain("314.90");
    expect(container.querySelector(".price-reference")).toBeNull();
  });
});
