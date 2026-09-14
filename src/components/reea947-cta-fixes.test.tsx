// @vitest-environment jsdom
/**
 * REEA-947 — regression pins for the REEA-943 QA verdict on the REEA-930 CTA
 * redesign (deployed stamp 563b21f):
 *
 *   AC1 — the CTA age line never rendered on a cold live collect. Root cause:
 *   the page bakes `renderStartMs` BEFORE the fan-out kicks off, so offers
 *   collected inside the same render carry stamps a few hundred ms AFTER the
 *   baked clock; ageSeconds read the negative delta as "no usable stamp" and
 *   every CTA fell back to the plain label. Pin: a stamp just after the
 *   render clock still renders the age line ("checked just now"), on the row
 *   CTA and the lead CTA alike.
 *
 *   AC2 — the lead CTA never said "with coupon" for the REEA-603
 *   delivered-discount restatement (compare-at 400 above selling 359.90,
 *   auto-applied coupon whose discount string is the unparseable delta
 *   "KD 40.10"; measured live on the QA stamp). The discount is already
 *   folded into the selling price, so the parseable-coupon comparison saw two
 *   equal figures. Pin: the basis claim fires on the lead offer's own
 *   compare-at, the figure is NOT discounted twice, and an unparseable coupon
 *   with no delivered discount still claims nothing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import { ageSeconds } from "@/lib/relative-time";
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

// The deployed-bug shape: the render clock is baked, THEN the offers are
// collected — so the stamps land a beat AFTER renderStartMs.
const RENDER_MS = Date.now();
const COLLECTED_DURING_RENDER = new Date(RENDER_MS + 200).toISOString();

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    productId: "p1",
    title: "Apple iPhone 17 Pro Max - eSIM",
    brand: "Apple",
    offers: [
      {
        merchant: "Wibi",
        price: 359.9,
        currency: "KWD",
        url: "https://wibi.example/p",
        inStock: true,
        collectedAt: COLLECTED_DURING_RENDER,
      },
      {
        merchant: "Blink",
        price: 364.9,
        currency: "KWD",
        url: "https://blink.example/p",
        inStock: true,
        collectedAt: COLLECTED_DURING_RENDER,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: new Date(RENDER_MS - 3_600_000).toISOString(),
    ...overrides,
  };
}

function lead(overrides: Partial<NormalizedProduct> = {}): { container: HTMLElement } {
  const { container } = render(
    <ProductResultCard
      product={product(overrides)}
      isBest
      query="iphone 17 pro max"
      rank={0}
      renderStartMs={RENDER_MS}
    />,
  );
  return { container };
}

describe("REEA-947 AC1 — a stamp collected during the render still anchors the CTA", () => {
  it("the row CTA renders the age line, not the plain fallback", () => {
    const { container } = lead();
    const rowCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Blink"),
    );
    expect(rowCta?.textContent).toContain("Checked");
    expect(rowCta?.textContent).not.toContain("Go to store");
  });

  it("the lead CTA carries the freshness line too", () => {
    const { container } = lead();
    const cta = container.querySelector(".cta-lead");
    expect(cta).not.toBeNull();
    expect(cta?.querySelector(".cta-lead-age")?.textContent).toContain("Checked");
  });

  it("ageSeconds floors a just-collected stamp at 0 and keeps null for missing/invalid", () => {
    expect(ageSeconds(COLLECTED_DURING_RENDER, RENDER_MS)).toBe(0);
    expect(ageSeconds(undefined, RENDER_MS)).toBeNull();
    expect(ageSeconds("not-a-date", RENDER_MS)).toBeNull();
    expect(ageSeconds("2026-09-14T06:28:24.000Z", Date.parse("2026-09-14T06:28:36.000Z"))).toBe(12);
  });
});

describe("REEA-947 AC2 — the delivered-discount restatement names its basis", () => {
  // The exact shape measured on the QA stamp: lead offer Wibi KD 359.90 under
  // a compare-at KD 400; coupons[] led by an unparseable "KD 55" from another
  // retailer, the derived "KD 40.10" delta further down the array.
  const qaCoupons = [
    { code: null, description: "KD 55", discount: "KD 55", expiresAt: null, merchant: "Xcite" },
    { code: null, description: "KD 40.10", discount: "KD 40.10", expiresAt: null, merchant: "Wibi" },
  ];
  const qaOffers = [
    {
      merchant: "Wibi",
      price: 359.9,
      currency: "KWD",
      url: "https://wibi.example/p",
      inStock: true,
      wasPrice: 400,
      collectedAt: COLLECTED_DURING_RENDER,
    },
    {
      merchant: "Blink",
      price: 364.9,
      currency: "KWD",
      url: "https://blink.example/p",
      inStock: true,
      collectedAt: COLLECTED_DURING_RENDER,
    },
  ] as NormalizedProduct["offers"];

  it("says 'with coupon' when the lead figure is the post-compare-at one", () => {
    const { container } = lead({ offers: qaOffers, coupons: qaCoupons });
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).toContain("with coupon");
    // The figure stays the selling price — the delta is never folded twice.
    expect(cta?.textContent).toContain("KD 359.90");
    expect(cta?.textContent).not.toContain("319.80");
  });

  it("still claims nothing when no delivered discount lowered the figure", () => {
    // Same unparseable coupon, but no compare-at on the lead offer: the
    // printed figure equals the listed one, so "with coupon" would be
    // decorative — REEA-784's never-decorative rule holds.
    const { container } = lead({ coupons: [qaCoupons[0]] });
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).not.toContain("with coupon");
    expect(cta?.textContent).toContain("KD 359.90");
  });

  it("a parseable coupon still folds once on top of the compare-at figure", () => {
    const { container } = lead({
      offers: qaOffers,
      coupons: [{ code: "SAVE10", description: "", discount: "10% off", expiresAt: null, merchant: "Xcite" }],
    });
    const cta = container.querySelector(".cta-lead");
    expect(cta?.textContent).toContain("with coupon");
    // 359.90 − 10% = 323.91 → the shared formatter prints KD 323.91.
    expect(cta?.textContent).toContain("KD 323.91");
  });
});
