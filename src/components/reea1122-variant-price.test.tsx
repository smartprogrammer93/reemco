// @vitest-environment jsdom
/**
 * REEA-1122 — product-hero variant chips must print the variant's ABSOLUTE
 * price (the results-card convention), never the raw `priceDelta`: the
 * cheapest variant (delta 0) used to render "Orange KD 0", which reads as
 * "free"/"no price" beside a paid product. The hero also must ride the SAME
 * live price pass it displays, so the selected chip equals the hero price and
 * a chip can never carry a figure from a different freshness pass.
 */
import { Suspense, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductHero from "@/components/ProductHero";
import ProductResultCard from "@/components/ProductResultCard";
import { resetSessionCacheForTests } from "@/lib/collect/useCollection";
import type { CollectJob } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";

// React 19 act() support for the async `use(firstStage)` render in this file.
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

const COLLECTED = "2026-09-05T21:00:00Z";
const RENDER_MS = Date.parse(COLLECTED) + 120_000;

beforeEach(() => resetSessionCacheForTests());
afterEach(() => {
  cleanup();
  resetSessionCacheForTests();
});

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    productId: "reea1122-probe",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers: [
      { merchant: "Xcite", price: 319.9, currency: "KWD", url: "https://www.xcite.com/p", inStock: true },
    ],
    coupons: [],
    variations: [
      { id: "orange", label: "Orange", priceDelta: 0 },
      { id: "blue", label: "Blue", priceDelta: 10 },
    ],
    alternatives: [],
    ...overrides,
  };
}

function job(livePrice: number | null): CollectJob {
  return {
    jobId: "job-reea1122",
    productId: "reea1122-probe",
    status: "complete",
    mode: "live",
    startedAt: COLLECTED,
    finishedAt: COLLECTED,
    subtasks:
      livePrice == null
        ? []
        : [{ retailer: "Xcite", domain: "xcite.com", status: "done", offersFound: 1 }],
    offers:
      livePrice == null
        ? []
        : [
            {
              merchant: "Xcite",
              domain: "xcite.com",
              price: livePrice,
              currency: "KWD",
              url: "https://www.xcite.com/p",
              inStock: true,
              collectedAt: COLLECTED,
              collectedAtEpochMs: Date.parse(COLLECTED),
              method: "live",
            },
          ],
  };
}

async function heroVariantSection(
  locale: "en" | "ar",
  p: NormalizedProduct,
  livePrice: number | null,
): Promise<HTMLElement> {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ProductHero
          product={p}
          locale={locale}
          firstStage={Promise.resolve(job(livePrice))}
          renderStartMs={RENDER_MS}
        />
      </Suspense>,
    );
  });
  const section = document.querySelector(".rc-variants");
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

function chipTexts(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll(".rc-variant")).map((el) => el.textContent ?? "");
}

describe("REEA-1122 — product-hero variant chips", () => {
  it("prints the absolute price, never the raw delta (Orange KD 0)", async () => {
    const section = await heroVariantSection("en", product(), 319.9);
    const chips = chipTexts(section);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toContain("Orange");
    expect(chips[0]).toContain("KD 319.90");
    expect(chips[1]).toContain("Blue");
    expect(chips[1]).toContain("KD 329.90");
    expect(chips.join(" ")).not.toMatch(/\bKD 0\b/);
    // The figure stays bidi-isolated in both directions.
    expect(section.querySelectorAll(".rc-variant bdi")).toHaveLength(2);
  });

  it("keeps the same absolute labels in Arabic/RTL", async () => {
    const section = await heroVariantSection("ar", product(), 319.9);
    const chips = chipTexts(section);
    expect(chips[0]).toContain("KD 319.90");
    expect(chips[1]).toContain("KD 329.90");
    expect(chips.join(" ")).not.toMatch(/\bKD 0\b/);
  });

  it("rides the live hero price, not a stale identity base from another pass", async () => {
    // The identity record says KD 319.90 but this hero's live pass found KD 363
    // (the live box's real case: results card 314.90, product hero 363). The
    // chip must agree with the price on THIS screen.
    const section = await heroVariantSection("en", product(), 363);
    const chips = chipTexts(section);
    expect(chips[0]).toContain("KD 363");
    expect(chips[1]).toContain("KD 373");
  });

  it("renders the name only when no priced offer exists, never KD 0", async () => {
    const section = await heroVariantSection("en", product({ offers: [] }), null);
    const chips = chipTexts(section);
    expect(chips[0]).toBe("Orange");
    expect(chips[1]).toBe("Blue");
  });

  it("matches the results-card convention for the same product", async () => {
    const section = await heroVariantSection("en", product(), 319.9);
    const heroChips = chipTexts(section);
    const { container } = render(
      <ProductResultCard
        product={product()}
        country={null}
        locale="en"
        query="iphone 17 pro"
        rank={0}
        renderStartMs={RENDER_MS}
      />,
    );
    const resultsChips = Array.from(
      container.querySelectorAll(".rc-variants .rc-variant"),
    ).map((el) => el.textContent ?? "");
    expect(resultsChips).toHaveLength(2);
    expect(resultsChips[0]).toBe(heroChips[0]);
    expect(resultsChips[1]).toBe(heroChips[1]);
  });
});
