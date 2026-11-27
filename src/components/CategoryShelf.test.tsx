// @vitest-environment jsdom
/**
 * REEA-1268 — the `/c/<slug>` shelf's shopper-facing honesty contract.
 *
 * These render the streamed category shelf from a settled live flush and pin
 * the D-3 rule: the count/coverage line is folded over the cards the page
 * actually painted, a zero shelf never says "N carry this", and every painted
 * card is the real live card (its PDP link is on the card).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { Suspense, act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/c/laptops",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
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

import CategoryShelf from "@/components/CategoryShelf";
import { categoryBySlug } from "@/lib/categories";
import type { CategoryStage } from "@/lib/category-shelf";
import type { NormalizedProduct } from "@/types/product";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-11-27T20:00:00Z");

function product(id: string, title: string, offers: NormalizedProduct["offers"]): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "Brand",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-27T20:00:00.000Z",
    scrapedAtEpochMs: NOW,
    productScope: "primary",
  };
}

function stage(over: Partial<CategoryStage> = {}): CategoryStage {
  return {
    cards: [],
    notes: [],
    collectedAt: "2026-11-27T20:00:00.000Z",
    collectedAtEpochMs: NOW,
    settled: true,
    partial: false,
    answeredTerms: 1,
    totalTerms: 1,
    ...over,
  };
}

async function renderShelf(value: CategoryStage, locale: "en" | "ar" = "en") {
  const def = categoryBySlug("laptops")!;
  await act(async () => {
    render(
      <Suspense fallback={<p>loading</p>}>
        <CategoryShelf
          stages={[Promise.resolve(value)]}
          def={def}
          country="KW"
          locale={locale}
          renderStartMs={NOW}
        />
      </Suspense>,
    );
  });
}

describe("REEA-1268 D-3 — the category count/coverage line", () => {
  it("counts exactly the cards it painted and folds coverage over them", async () => {
    const cards = [
      product("asus-vivobook-15", "ASUS VivoBook 15 Laptop", [
        { merchant: "Xcite", price: 210, currency: "KWD", url: "https://xcite.example/1", inStock: true },
        { merchant: "Eureka", price: 219, currency: "KWD", url: "https://eureka.example/1", inStock: true },
      ]),
      product("hp-pavilion-14", "HP Pavilion 14 Laptop", [
        { merchant: "Xcite", price: 240, currency: "KWD", url: "https://xcite.example/2", inStock: true },
      ]),
    ];
    await renderShelf(
      stage({
        cards,
        notes: [
          { merchant: "Xcite", hits: 2 },
          { merchant: "Eureka", hits: 1 },
          { merchant: "Jarir", hits: 0, error: "no answer" },
        ],
      }),
    );
    // The count line names the two painted cards, not the payload's six slots.
    const line = await screen.findByRole("status");
    expect(line.textContent).toContain("2 live cards");
    expect(line.getAttribute("data-category-shelf-cards")).toBe("2");
    // The coverage sentence reads the painted cards: two stores carry them.
    const coverage = document.querySelector(".rc-cat-coverage");
    expect(coverage?.textContent).toContain("2 carry this");
    expect(coverage?.textContent).toContain("1 failed");
    // Every painted card is a real product card with a PDP link.
    const ids = [...document.querySelectorAll("[data-product-id]")].map((el) =>
      el.getAttribute("data-product-id"),
    );
    expect(ids).toEqual(["asus-vivobook-15", "hp-pavilion-14"]);
    expect(document.querySelector('a[href^="/product/asus-vivobook-15"]')).toBeTruthy();
  });

  it("says 'none carry this' on a zero shelf instead of inventing a carrier", async () => {
    await renderShelf(
      stage({
        cards: [],
        notes: [
          { merchant: "Xcite", hits: 0 },
          { merchant: "Eureka", hits: 0 },
        ],
      }),
    );
    const line = await screen.findByRole("status");
    expect(line.textContent).toContain("No live match this load");
    expect(line.textContent).toContain("2 stores were checked");
    const coverage = document.querySelector(".rc-cat-coverage");
    expect(coverage?.textContent).toContain("none carry this");
    expect(coverage?.textContent).not.toMatch(/\d+ carry this/);
  });

  it("renders the Arabic count line with the locale agreement", async () => {
    await renderShelf(
      stage({
        cards: [
          product("asus-vivobook-15", "ASUS VivoBook 15 Laptop", [
            { merchant: "Xcite", price: 210, currency: "KWD", url: "https://xcite.example/1", inStock: true },
          ]),
        ],
        notes: [{ merchant: "Xcite", hits: 1 }],
      }),
      "ar",
    );
    const line = await screen.findByRole("status");
    expect(line.textContent).toContain("بطاقة مباشرة واحدة");
  });
});
