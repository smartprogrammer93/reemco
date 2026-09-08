// @vitest-environment jsdom
/**
 * REEA-281 render-side coverage.
 * AC-1: ≤2 lazy-loaded thumbnails per product row, text-only fallback when
 *       the feed carries no images (never an invented placeholder).
 * AC-2: the converted side of every price reads ≤2 decimals behind ≈; a
 *       KWD-native keeps its exact fils precision (format.test.ts covers the
 *       formatter itself — this checks the CARD actually uses it).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import type { NormalizedProduct } from "@/types/product";

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

function product(withImages: boolean): NormalizedProduct {
  const img = (n: number) => (withImages ? `https://cdn.example/${n}.png` : undefined);
  return {
    productId: "p1",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    ...(img(1) ? { image: img(1) } : {}),
    offers: [
      { merchant: "Xcite", price: 99, currency: "KWD", url: "https://xcite.example/p", inStock: true, ...(img(1) ? { image: img(1) } : {}) },
      { merchant: "Jarir", price: 499, currency: "SAR", url: "https://jarir.example/p", inStock: true, ...(img(2) ? { image: img(2) } : {}) },
      { merchant: "Eureka", price: 105, currency: "KWD", url: "https://eureka.example/p", inStock: false, ...(img(3) ? { image: img(3) } : {}) },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-08T00:00:00.000Z",
  };
}

describe("REEA-281 AC-1 — thumbnails per product row", () => {
  it("renders at most 2 thumbnails, deduped across card + offer images", () => {
    const { container } = render(<ProductResultCard product={product(true)} query="headphones" rank={0} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    // Card photo (a.png, also on offer 1 → ONE slot) + first distinct offer
    // photo (b.png); c.png never gets a third slot.
    expect(imgs).toHaveLength(2);
    expect(imgs.map((i) => i.getAttribute("src")).sort()).toEqual([
      "https://cdn.example/1.png",
      "https://cdn.example/2.png",
    ]);
  });

  it("thumbnails are lazy + async-decoded, so first paint never waits on them", () => {
    const { container } = render(<ProductResultCard product={product(true)} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
      // Fixed intrinsic box reserves layout space (no CLS when the photo lands).
      expect(img.getAttribute("width")).toBe("64");
      expect(img.getAttribute("height")).toBe("64");
    }
  });

  it("image-less feed renders the plain text-only row — no placeholder invented", () => {
    const { container } = render(<ProductResultCard product={product(false)} query="headphones" />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // The row itself still renders its identities.
    expect(container.textContent).toContain("Sony WH-1000XM6");
  });
});

describe("REEA-281 AC-2 — converted price on the rendered card", () => {
  it("converted figures carry ≈ and ≤2 decimals; KWD-native keeps its figure", () => {
    const { container } = render(<ProductResultCard product={product(false)} query="headphones" />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    // SAR 499 → 40.7184 KD: the rendered reference shows ≈ and two decimals.
    expect(text).toMatch(/≈\s?KWD 40\.72(?![\d.])/);
    // The scraped SAR stamp keeps its exact rendered precision beside it.
    expect(text).toContain("SAR 499.00");
    // KWD-native 99 leads untouched — Intl's own fils width (three decimals
    // for KWD) is what "precision unchanged" means on the rendered row, and
    // the native figure carries no ≈ of its own.
    expect(text).toMatch(/KWD 99\.000(?![\d])/);
    expect(/≈\s?KWD 99/.test(text)).toBe(false);
  });
});
