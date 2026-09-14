// @vitest-environment jsdom
/**
 * REEA-930 — offer-link CTA redesign, component-level coverage of the CTA
 * contract (the deployed-stamp AC1–AC6 pass belongs to QA; these pins catch
 * the regressions the smallest check can catch):
 *   AC1 — every offer CTA with a known collectedAt renders the collection
 *         age; no stamp falls back to the plain label.
 *   AC2 — the lead primary CTA states the best EFFECTIVE price (the same
 *         effectivePriceKwd arithmetic the ranking uses, REEA-896 formatter
 *         chain) + destination retailer; a coupon-folded figure names its
 *         basis.
 *   AC3 — while the Kuwait batch is pending, the lead CTA carries the
 *         REEA-835/847 checking state — never an unqualified "Best …" claim.
 *   AC4 — the click payload shape is unchanged (type/query/rank/item_id/
 *         outbound_url) — data minimization, no new fields.
 *   AC6 — age and price copy localize in AR.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import OfferCard from "@/components/OfferCard";
import { trackEvent } from "@/lib/telemetry";
import { localizedAge } from "@/lib/i18n";
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

vi.mock("@/lib/telemetry", () => ({ trackEvent: vi.fn(), trackEvents: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Real-clock fixture: the OfferCard surface has no baked renderStartMs (it
// renders client-side from the live job), so its age derives from Date.now().
const RENDER_MS = Date.now();
const FRESH_AT = new Date(RENDER_MS - 12_000).toISOString();

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    productId: "p1",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: [
      {
        merchant: "Xcite",
        price: 99,
        currency: "KWD",
        url: "https://xcite.example/p",
        inStock: true,
        collectedAt: FRESH_AT,
      },
      {
        merchant: "Eureka",
        price: 105,
        currency: "KWD",
        url: "https://eureka.example/p",
        inStock: true,
        collectedAt: FRESH_AT,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: new Date(RENDER_MS - 3_600_000).toISOString(),
    ...overrides,
  };
}

function lead(overrides: Partial<NormalizedProduct> = {}): { container: HTMLElement; p: NormalizedProduct } {
  const p = product(overrides);
  const { container } = render(
    <ProductResultCard product={p} isBest query="headphones" rank={0} renderStartMs={RENDER_MS} />,
  );
  return { container, p };
}

describe("REEA-930 AC1 — freshness-anchored offer CTAs", () => {
  it("renders the collection age + retailer on a non-lead row CTA", () => {
    const { container } = lead();
    const rowCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Eureka"),
    );
    expect(rowCta?.textContent).toContain("Checked");
    expect(rowCta?.textContent).toContain(localizedAge("en", 12));
    expect(rowCta?.textContent).toContain("Eureka");
  });

  it("falls back to the plain label when the offer carries no stamp", () => {
    const offers = product().offers.map((o, i) => (i === 1 ? { ...o, collectedAt: undefined } : o));
    const { container } = lead({ offers });
    const rowCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Go to store"),
    );
    expect(rowCta?.textContent).toBe("Go to store");
  });

  it("falls back to the plain label on an invalid stamp", () => {
    const offers = product().offers.map((o, i) => (i === 1 ? { ...o, collectedAt: "not-a-date" } : o));
    const { container } = lead({ offers });
    const rowCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Go to store"),
    );
    expect(rowCta?.textContent).toBe("Go to store");
  });

  it("the OfferCard (detail view) CTA carries the age too, with plain fallback", () => {
    const fresh = render(
      <OfferCard
        merchant="Xcite"
        priceLabel="KD 29.90"
        inStock
        url="https://xcite.example/p"
        collectedAt={FRESH_AT}
        method="live"
        isBest={false}
        savings={null}
      />,
    );
    expect(fresh.container.querySelector("a")?.textContent).toContain("Checked");
    cleanup();
    const stale = render(
      <OfferCard
        merchant="Xcite"
        priceLabel="KD 29.90"
        inStock
        url="https://xcite.example/p"
        collectedAt="garbage"
        method="live"
        isBest={false}
        savings={null}
      />,
    );
    expect(stale.container.querySelector("a")?.textContent).toContain("View at Xcite");
  });
});

describe("REEA-930 AC2 — lead primary CTA states effective price + retailer", () => {
  it("renders 'Best effective price KD 99 → Xcite' on the lead card", () => {
    const { container } = lead();
    const cta = container.querySelector(".cta-lead");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Best effective price");
    expect(cta?.textContent).toContain("KD 99");
    expect(cta?.textContent).toContain("Xcite");
    expect(cta?.getAttribute("href")).toBe("https://xcite.example/p");
  });

  it("names the coupon basis when the figure folds the card coupon", () => {
    const { container } = lead({
      coupons: [{ code: "SAVE10", description: "", discount: "10% off", expiresAt: null, merchant: "Xcite" }],
    });
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).toContain("with coupon");
    // 99 KWD − 10% = 89.1 → the shared formatter prints KD 89.10 (REEA-896).
    expect(cta?.textContent).toContain("KD 89.10");
  });

  it("suppresses the best row's own button while the primary CTA renders", () => {
    const { container } = lead();
    const storeButtons = Array.from(container.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("Checked") && a.textContent?.includes("Xcite"),
    );
    // The lead CTA itself is the only Xcite action; no duplicate row button.
    expect(storeButtons).toHaveLength(1);
    expect(storeButtons[0].classList.contains("cta-lead")).toBe(true);
  });

  it("no primary CTA on non-lead cards — rows keep their age-anchored buttons", () => {
    const { container } = render(
      <ProductResultCard product={product()} isBest={false} query="headphones" rank={1} renderStartMs={RENDER_MS} />,
    );
    expect(container.querySelector(".cta-lead")).toBeNull();
    const rowCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Checked"),
    );
    expect(rowCta).toBeDefined();
  });

  it("best offer out of stock → the CTA rides the best AVAILABLE (in-stock) offer", () => {
    // sortOrders ranks in-stock first, so the in-stock Eureka becomes the
    // flagged best — the CTA states ITS effective figure (one claim, the
    // flag's offer), never the OOS row's.
    const offers = product().offers.map((o, i) => (i === 0 ? { ...o, inStock: false } : o));
    const { container } = lead({ offers });
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).toContain("Eureka");
    expect(cta?.textContent).toContain("KD 105");
  });

  it("no primary CTA when nothing is in stock", () => {
    const offers = product().offers.map((o) => ({ ...o, inStock: false }));
    const { container } = lead({ offers });
    expect(container.querySelector(".cta-lead")).toBeNull();
  });
});

describe("REEA-930 AC3 — pending state suppresses the 'Best' claim", () => {
  it("renders the checking state, never 'Best effective price', while pending", () => {
    // Non-KWD interim lead + batch pending — the REEA-847 shape.
    const offers = product().offers.map((o, i) =>
      i === 0 ? { ...o, merchant: "Amazon.eg", price: 500, currency: "EGP" } : o,
    );
    const { container } = render(
      <ProductResultCard
        product={product({ offers })}
        isBest
        kuwaitBatchPending
        kuwaitPendingStatus
        query="headphones"
        rank={0}
        renderStartMs={RENDER_MS}
      />,
    );
    const cta = container.querySelector(".cta-lead");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Checking Kuwait stores…");
    expect(cta?.textContent).not.toContain("Best effective price");
    // Still a real link (graceful degradation) with its freshness line.
    expect(cta?.getAttribute("href")).toBe("https://xcite.example/p");
    expect(cta?.textContent).toContain("Checked");
  });

  it("flips to the price claim once the batch settles", () => {
    const { container } = render(
      <ProductResultCard product={product()} isBest query="headphones" rank={0} renderStartMs={RENDER_MS} />,
    );
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).toContain("Best effective price");
    expect(cta?.textContent).not.toContain("Checking Kuwait stores…");
  });
});

describe("REEA-930 AC4 — click payload shape unchanged", () => {
  it("fires exactly type/query/rank/item_id/outbound_url — no new fields", () => {
    const { container } = lead();
    const cta = container.querySelector(".cta-lead") as HTMLAnchorElement;
    fireEvent.click(cta);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith({
      type: "item_clicked",
      query: "headphones",
      rank: 0,
      item_id: "p1",
      outbound_url: "https://xcite.example/p",
    });
    const arg = vi.mocked(trackEvent).mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["item_id", "outbound_url", "query", "rank", "type"]);
  });
});

describe("REEA-930 AC6 — Arabic locale", () => {
  it("localizes the lead CTA and the row CTA age copy", () => {
    const { container } = render(
      <ProductResultCard
        product={product()}
        isBest
        query="سماعات"
        rank={0}
        renderStartMs={RENDER_MS}
        locale="ar"
      />,
    );
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).toContain("أفضل سعر فعلي");
    expect(cta?.textContent).toContain("←");
    expect(cta?.textContent).toContain("KD 99");
    expect(cta?.textContent).toContain("تم التحقق");
    expect(cta?.textContent).toContain(localizedAge("ar", 12));
    const rowCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Eureka"),
    );
    expect(rowCta?.textContent).toContain("تم التحقق");
  });
});

describe("REEA-930 — localizedAge ladder", () => {
  it("mirrors the relativeAge buckets in both locales", () => {
    expect(localizedAge("en", 12)).toBe("12s ago");
    expect(localizedAge("en", 125)).toBe("2m ago");
    expect(localizedAge("en", 7200)).toBe("2h ago");
    expect(localizedAge("en", 172800)).toBe("2d ago");
    expect(localizedAge("ar", 12)).toBe("قبل 12ث");
    expect(localizedAge("ar", 125)).toBe("قبل 2د");
    expect(localizedAge("ar", 7200)).toBe("قبل 2س");
    expect(localizedAge("ar", 172800)).toBe("قبل 2ي");
  });
});
