// @vitest-environment jsdom
/**
 * REEA-1095 AC10/AC11 — the product freshness note must render a humanised,
 * localised age. QA measured "Live results · collected 0s ago" in EN and
 * "جُمعت 1s ago" in AR on the deployed Shelf build; the fix routes the note
 * through localizedAgeFromStamp (REEA-1070's localizedAgePair ladder), so
 * sub-minute reads "just now"/"الآن" and Arabic never carries an English
 * "s ago"/"min ago" suffix.
 */
import { Suspense, act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductHero from "@/components/ProductHero";
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

beforeEach(() => resetSessionCacheForTests());
afterEach(() => {
  cleanup();
  resetSessionCacheForTests();
});

function product(): NormalizedProduct {
  return {
    productId: "reea1095-probe",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function job(collectedAt: string): CollectJob {
  return {
    jobId: "job-reea1095",
    productId: "reea1095-probe",
    status: "complete",
    mode: "live",
    startedAt: collectedAt,
    finishedAt: collectedAt,
    subtasks: [
      { retailer: "Xcite", domain: "xcite.com", status: "done", offersFound: 1 },
    ],
    offers: [
      {
        merchant: "Xcite",
        domain: "xcite.com",
        price: 333.9,
        currency: "KWD",
        url: "https://www.xcite.com/apple-iphone-17-pro-6-3-256gb-silver/p",
        inStock: true,
        collectedAt,
        collectedAtEpochMs: Date.parse(collectedAt),
        method: "live",
      },
    ],
  };
}

async function noteText(locale: "en" | "ar", collectedAt: string): Promise<string> {
  cleanup();
  resetSessionCacheForTests();
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ProductHero
          product={product()}
          locale={locale}
          firstStage={Promise.resolve(job(collectedAt))}
        />
      </Suspense>,
    );
  });
  const button = await screen.findByRole("button", {
    name: locale === "ar" ? "اجمع من جديد" : "Collect again",
  });
  return button.closest("p")?.textContent ?? "";
}

describe("REEA-1095 AC10/AC11 — product freshness note", () => {
  it("renders just now / الآن for a sub-minute stamp, never 0s ago or 1s ago", async () => {
    const fresh = new Date(Date.now() - 5_000).toISOString();
    const en = await noteText("en", fresh);
    expect(en).toContain("Live results · collected just now · Collect again");
    expect(en).not.toMatch(/\d+s ago/);

    const ar = await noteText("ar", fresh);
    expect(ar).toContain("نتائج مباشرة · جُمعت الآن · اجمع من جديد");
    expect(ar).not.toMatch(/s ago/);
    expect(ar).not.toContain("0s");
  });

  it("localises a minute age instead of splicing an English suffix onto AR", async () => {
    const fourMin = new Date(Date.now() - 4 * 60_000).toISOString();
    expect(await noteText("en", fourMin)).toContain("collected 4 min ago");
    expect(await noteText("ar", fourMin)).toContain("جُمعت قبل 4 دقائق");
  });
});
