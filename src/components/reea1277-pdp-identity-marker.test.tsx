// @vitest-environment jsdom
/**
 * REEA-1277 — the PDP states the identity it actually resolved.
 *
 * The sitemap probe asserts `data-product-id` equals the listed URL's own key.
 * Without a server-rendered identity marker the probe could only read the
 * <link rel="canonical"> tag, which was self-aligned even on pages whose body
 * painted another product's offer set (the measured S-2 defect). This pin
 * keeps the marker on the page identity and out of the nested result cards.
 */
import { Suspense, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductHero from "@/components/ProductHero";
import { resetSessionCacheForTests } from "@/lib/collect/useCollection";
import type { CollectJob } from "@/lib/collect/types";
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

const STAMP = "2026-11-27T12:00:00.000Z";

function product(): NormalizedProduct {
  return {
    productId: "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
    title: "SanDisk Extreme PRO micro SDXC UHS-I Card Adapter 256GB",
    brand: "SanDisk",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function job(): CollectJob {
  return {
    jobId: "job-reea1277",
    productId: "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
    status: "complete",
    mode: "live",
    startedAt: STAMP,
    finishedAt: STAMP,
    subtasks: [{ retailer: "Eureka", domain: "eureka.com.kw", status: "done", offersFound: 1 }],
    offers: [
      {
        merchant: "Eureka",
        domain: "eureka.com.kw",
        price: 8.9,
        currency: "KWD",
        url: "https://www.eureka.com.kw/products/details/sandisk-extreme-pro-256gb",
        inStock: true,
        collectedAt: STAMP,
        collectedAtEpochMs: Date.parse(STAMP),
        method: "live",
      },
    ],
  };
}

describe("REEA-1277 — the PDP identity marker names the resolved product", () => {
  it("renders data-product-id as the resolved identity", async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ProductHero product={product()} locale="en" firstStage={Promise.resolve(job())} />
        </Suspense>,
      );
    });
    const hero = document.querySelector(".rc-product-wrap");
    expect(hero).not.toBeNull();
    expect(hero!.getAttribute("data-product-id")).toBe(
      "sandisk-extreme-pro-micro-sdxc-uhs-i-card-adapter-256gb",
    );
  });
});
