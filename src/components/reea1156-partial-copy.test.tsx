// @vitest-environment jsdom
/**
 * REEA-1156 D3 — the partial-response line separates the answered count from
 * the retailer list. Before the fix it rendered "5 retailers answered Eureka"
 * / "استجاب 5 المتاجر Eureka", which reads as a verb phrase.
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
    productId: "reea1156-partial",
    title: "Sony WH-1000XM6 Wireless Headphones",
    brand: "Sony",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function liveOffer(merchant: string, price: number): LiveOffer {
  const stamp = new Date(Date.now() - 5_000).toISOString();
  return {
    merchant,
    domain: `${merchant.toLowerCase().replace(/\s+/g, "")}.com.kw`,
    price,
    currency: "KWD",
    url: `https://${merchant.toLowerCase().replace(/\s+/g, "")}.com.kw/p`,
    inStock: true,
    collectedAt: stamp,
    collectedAtEpochMs: Date.now() - 5_000,
    method: "live",
  };
}

function job(): CollectJob {
  const stamp = new Date(Date.now() - 5_000).toISOString();
  return {
    jobId: "job-reea1156",
    productId: "reea1156-partial",
    status: "complete",
    mode: "live",
    startedAt: stamp,
    finishedAt: stamp,
    subtasks: [
      { retailer: "Wibi", domain: "wibi.com.kw", status: "done", offersFound: 1 },
      { retailer: "Xcite", domain: "xcite.com", status: "done", offersFound: 1 },
      { retailer: "Eureka", domain: "eureka.com.kw", status: "failed", offersFound: 0 },
    ],
    offers: [liveOffer("Wibi", 119.9), liveOffer("Xcite", 124.9)],
  };
}

async function renderHero(locale: "en" | "ar"): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    const result = render(
      <Suspense fallback={null}>
        <ProductHero product={product()} locale={locale} firstStage={Promise.resolve(job())} />
      </Suspense>,
    );
    container = result.container;
  });
  return container;
}

describe("REEA-1156 D3 — partial-response copy separator", () => {
  it("EN separates the count from the retailer list", async () => {
    const container = await renderHero("en");
    const partial = container.querySelector(".rc-partial");
    expect(partial?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "2 retailers answered · Eureka",
    );
    // The Latin retailer name stays an isolated bdi (.lat = ltr + isolate).
    expect(partial?.querySelector("bdi")?.className).toContain("lat");
  });

  it("AR separates the count from the retailer list", async () => {
    const container = await renderHero("ar");
    const partial = container.querySelector(".rc-partial");
    expect(partial?.textContent?.replace(/\s+/g, " ").trim()).toBe("استجاب 2 متاجر: Eureka");
    expect(partial?.querySelector("bdi")?.className).toContain("lat");
  });
});
