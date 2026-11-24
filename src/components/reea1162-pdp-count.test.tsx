// @vitest-environment jsdom
/**
 * REEA-1162 — the product page renders ONE row per distinct retailer offer and
 * its count line names DISTINCT retailers.
 *
 * Live defect (REEA-1118 on d9f31b54): HD16 PDP said "All offers · 5
 * retailers" but listed Eureka ×5 + Zayoom; DualSense said "6 retailers" but
 * listed Wibi ×2, Astore ×2, Eureka ×2. The collect run scrapes one listing per
 * merged-card row, so a retailer's same-price colourway listings stacked as
 * duplicate rows and the count read offers.length.
 */
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

function product(): NormalizedProduct {
  return {
    productId: "dyson-supersonic-nural-hd16",
    title: "Dyson Supersonic Nural Hair Dryer HD16",
    brand: "Dyson",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function liveOffer(merchant: string, price: number, url: string): LiveOffer {
  return {
    merchant,
    domain: `${merchant.toLowerCase().replace(/\s+/g, "")}.com.kw`,
    price,
    currency: "KWD",
    url,
    inStock: true,
    collectedAt: new Date(Date.now() - 5_000).toISOString(),
    collectedAtEpochMs: Date.now() - 5_000,
    method: "live",
  };
}

/** The failing HD16 shape: five Eureka listings at one price + Zayoom. */
function job(): CollectJob {
  const stamp = new Date(Date.now() - 5_000).toISOString();
  const eurekaListings = ["apricot", "amber", "blue", "red", "pink"];
  return {
    jobId: "job-reea1162",
    productId: "dyson-supersonic-nural-hd16",
    status: "complete",
    mode: "live",
    startedAt: stamp,
    finishedAt: stamp,
    subtasks: [
      ...eurekaListings.map((c) => ({
        retailer: "Eureka",
        domain: "eureka.com.kw",
        status: "done" as const,
        offersFound: 1,
      })),
      { retailer: "Zayoom", domain: "zayoom.com", status: "done" as const, offersFound: 1 },
    ],
    offers: [
      ...eurekaListings.map((c) => liveOffer("Eureka", 119.95, `https://eureka.com.kw/${c}`)),
      liveOffer("Zayoom", 139, "https://zayoom.com/hd16-pink"),
    ],
  };
}

async function renderHero(): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    const result = render(
      <Suspense fallback={null}>
        <ProductHero product={product()} locale="en" firstStage={Promise.resolve(job())} />
      </Suspense>,
    );
    container = result.container;
  });
  return container;
}

describe("REEA-1162 — product page retailer count and rows", () => {
  it("says 2 retailers for five Eureka listings plus Zayoom, and paints 2 rows", async () => {
    const container = await renderHero();
    const heading = container.querySelector(".rc-offers-table h2");
    expect(heading?.textContent).toBe("All offers · 2 retailers");
    // One row per distinct retailer offer: no duplicate Eureka rows.
    const tableRows = container.querySelectorAll(".rc-offers-table .rc-offer-row");
    expect(tableRows).toHaveLength(2);
    const retailers = [...tableRows].map(
      (r) => r.querySelector(".rc-retailer-name")?.textContent?.trim() ?? "",
    );
    expect(retailers).toEqual(["Eureka", "Zayoom"]);
    // The "N retailers answered" line is a retailer count too, not a listing
    // count (six subtasks, two retailers).
    expect(container.textContent).toContain("2 retailers answered");
  });
});
