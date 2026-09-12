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
import { buildCouponRows } from "@/components/CouponLine";
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
    expect(text).toMatch(/≈\s?KD 40\.72(?![\d.])/);
    // The scraped SAR stamp keeps its exact rendered precision beside it.
    expect(text).toContain("SAR 499.00");
    // KWD-native 99 leads untouched — REEA-488: whole amounts render bare in
    // the KD form (no trailing-zero noise on round figures), and the native
    // figure carries no ≈ of its own.
    expect(text).toMatch(/KD 99(?![.\d])/);
    expect(/≈\s?KD 99/.test(text)).toBe(false);
  });
});

describe("REEA-283 — country-led price rows (hero + retailer rows)", () => {
  const SCRAPED_AT = "2026-09-07T00:00:00.000Z";
  const sarProduct: NormalizedProduct = {
    productId: "apple-iphone-17-pro",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers: [
      { merchant: "Xcite", price: 5199, currency: "SAR", url: "https://xcite.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: SCRAPED_AT,
  };
  const kwdProduct: NormalizedProduct = {
    ...sarProduct,
    productId: "apple-iphone-17-pro-kw",
    offers: [
      { merchant: "Jarir", price: 424.238, currency: "KWD", url: "https://jarir.example/p", inStock: true },
    ],
  };

  it("c=SA: SAR leads hero AND retailer rows; the converted stamp rides behind as .price-alt", () => {
    const { container } = render(
      <ProductResultCard product={sarProduct} isBest query="iphone 17 pro" rank={0} country="SA" />,
    );
    const primary = Array.from(container.querySelectorAll(".price-cur"));
    expect(primary.length).toBeGreaterThanOrEqual(2); // hero + offer row
    for (const span of primary) {
      expect(span.textContent?.replace(/\s+/g, " ").trim().startsWith("SAR")).toBe(true);
    }
    const alt = Array.from(container.querySelectorAll(".price-alt"));
    expect(alt.length).toBeGreaterThanOrEqual(2);
    for (const span of alt) {
      expect(span.textContent?.replace(/\s+/g, " ")).toMatch(/^· ≈?\s?KD\b/);
    }
    // Hero treatment on the PRIMARY span only: price font + savings colour;
    // the retailer-row primary carries 600/ink; the muted stamp is pure CSS.
    expect(primary[0].getAttribute("style")).toContain("--rc-text-price");
    expect(primary[0].getAttribute("style")).toContain("--rc-savings");
    expect(primary[1].getAttribute("style")).toContain("font-weight: 600");
    expect(primary[1].getAttribute("style")).toContain("--rc-ink");
    expect(alt[1].getAttribute("style")).toBeNull();
  });

  it("c=KW over KWD-native offers: ONE figure capped at hundredths — no stamp", () => {
    const { container } = render(
      <ProductResultCard product={kwdProduct} query="iphone 17 pro" rank={0} country="KW" />,
    );
    const primary = Array.from(container.querySelectorAll(".price-cur"));
    expect(primary.length).toBeGreaterThanOrEqual(2);
    // REEA-574 R2: the scraped 424.238 prints as KD 424.24 everywhere on the
    // card — hero and retailer rows share formatKWD, no third decimal leaks.
    for (const span of primary) expect(span.textContent).toContain("KD 424.24");
    expect(container.querySelectorAll(".price-alt").length).toBe(0);
  });

  it("with no country selection the scraped figure still leads (native-first)", () => {
    const { container } = render(
      <ProductResultCard product={sarProduct} query="iphone 17 pro" rank={0} />,
    );
    const hero = container.querySelector(".price-cur");
    expect(hero?.textContent?.replace(/\s+/g, " ").trim().startsWith("SAR")).toBe(true);
  });
});

describe("REEA-283 — freshness digit ships in the first render", () => {
  const SCRAPED_AT = "2026-09-07T00:00:00.000Z";
  const withStamp: NormalizedProduct = {
    productId: "sony-xm6-fresh",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: [
      { merchant: "Xcite", price: 99, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: SCRAPED_AT,
  };
  const chipOf = (c: HTMLElement) => c.querySelector(".fresh-chip")?.textContent ?? "";

  it("the first render already carries the minute figure derived from renderStartMs", () => {
    const renderStartMs = Date.parse(SCRAPED_AT) + 3 * 60_000;
    const { container } = render(
      <ProductResultCard product={withStamp} query="xm6" rank={0} renderStartMs={renderStartMs} />,
    );
    expect(chipOf(container)).toMatch(/\d/);
    expect(chipOf(container).replace(/\s+/g, " ")).toContain("UPDATED 3 MINUTES AGO");
  });

  it("a repeated pass with the same renderStartMs reproduces identical chip text", () => {
    const renderStartMs = Date.parse(SCRAPED_AT) + 12 * 60_000;
    const props = { product: withStamp, query: "xm6", rank: 0, renderStartMs };
    const first = render(<ProductResultCard {...props} />);
    const ssrText = chipOf(first.container);
    cleanup();
    const second = render(<ProductResultCard {...props} />);
    expect(chipOf(second.container)).toBe(ssrText);
    expect(ssrText.replace(/\s+/g, " ")).toContain("UPDATED 12 MINUTES AGO");
  });

  it("a stale (>7d) stamp keeps the explicit outdated suffix", () => {
    const renderStartMs = Date.parse(SCRAPED_AT) + (8 * 24 * 60 + 5) * 60_000;
    const { container } = render(
      <ProductResultCard product={withStamp} query="xm6" rank={0} renderStartMs={renderStartMs} />,
    );
    expect(chipOf(container)).toContain("may be outdated");
  });
});

describe("REEA-468 G3 coupon-slot copy", () => {
  const noCoupon = product(false);
  const withCoupon: NormalizedProduct = {
    ...noCoupon,
    coupons: [{ code: "SAVE10", description: "10% off", discount: "10% off", expiresAt: null }],
  };

  it("an answered card without promos states 'No coupon available'", () => {
    const { container } = render(<ProductResultCard product={noCoupon} query="xm6" rank={0} />);
    expect(container.textContent).toContain("No coupon available");
    expect(container.querySelector(".coupon-badge")).toBeNull();
  });

  it("a promo listing shows the coupon honesty line instead of the empty-slot line", () => {
    const { container } = render(<ProductResultCard product={withCoupon} query="xm6" rank={0} />);
    // REEA-760: chip carries the CODE verbatim (paste-and-go), attribution
    // names the issuing retailer (unstamped record falls back to the card's
    // cheapest answering merchant — Jarir leads this fixture in KWD space),
    // ONE honest effective figure prints on that leading row. No (+n) counter,
    // no stacked amount beside the struck price.
    expect(container.querySelector(".coupon-badge")?.textContent).toContain("SAVE10");
    expect(container.querySelector(".coupon-via")?.textContent).toContain("via");
    expect(container.querySelector(".coupon-via")?.textContent).toContain("Jarir");
    expect(container.querySelector(".coupon-effective")?.textContent).toContain("SAR 449.10");
    expect(container.querySelectorAll(".coupon-line")).toHaveLength(1);
    expect(container.textContent).not.toContain("+1");
    expect(container.textContent).not.toContain("No coupon available");
  });

  it("the Arabic locale mirrors the same distinction", () => {
    const { container } = render(
      <ProductResultCard product={noCoupon} query="كيبورد" rank={0} locale="ar" />,
    );
    expect(container.textContent).toContain("لا توجد قسيمة متاحة");
  });
});

describe("REEA-760 coupon honesty line", () => {
  const hopStamped: NormalizedProduct = {
    ...product(false),
    coupons: [
      { code: "SAVEKD45", description: "10% off", discount: "10% off", expiresAt: null, merchant: "Xcite" },
      { code: null, description: "5% off", discount: "5% off", expiresAt: null, merchant: "Jarir" },
    ],
  };

  it("one line per issuing retailer; the effective figure prints exactly once", () => {
    const { container } = render(<ProductResultCard product={hopStamped} query="xm6" rank={0} />);
    const lines = Array.from(container.querySelectorAll(".coupon-line"));
    expect(lines).toHaveLength(2);
    // Xcite row: code verbatim (paste-and-go) + hop attribution, no number —
    // Jarir holds the cheapest matching offer, so ONLY its row carries it.
    expect(lines[0].querySelector(".coupon-badge")?.textContent).toBe("SAVEKD45");
    expect(lines[0].querySelector(".coupon-via")?.textContent).toContain("Xcite");
    expect(lines[0].querySelector(".coupon-effective")).toBeNull();
    // Jarir row: no code → the exact EN auto-note (one-step redeemable).
    expect(lines[1].querySelector(".coupon-badge")?.textContent).toBe("auto-applied at checkout");
    expect(container.querySelectorAll(".coupon-effective")).toHaveLength(1);
    expect(container.textContent).not.toContain("+1");
  });

  it("AR mirrors the copy verbatim with bidi-isolated merchant and number", () => {
    const { container } = render(
      <ProductResultCard product={hopStamped} query="كيبورد" rank={0} locale="ar" />,
    );
    const badges = container.querySelectorAll(".coupon-badge");
    expect(badges[0]?.textContent).toBe("SAVEKD45");
    expect(badges[1]?.textContent).toBe("تُطبَّق تلقائيًا عند الدفع");
    const via = container.querySelector(".coupon-via");
    expect(via?.textContent).toContain("من");
    // The Latin merchant name rides a bidi isolate under RTL flow.
    expect(via?.querySelector("bdi")?.textContent).toBe("Xcite");
    const eff = container.querySelector(".coupon-effective");
    expect(eff?.querySelector("bdi")?.textContent).toBe("SAR 474.05");
  });

  it("paired EN/AR renders of one query print the identical formatted figure", () => {
    const en = render(<ProductResultCard product={hopStamped} query="xm6" rank={0} />);
    const enNum = en.container.querySelector(".coupon-effective bdi")?.textContent;
    cleanup();
    const ar = render(<ProductResultCard product={hopStamped} query="xm6" rank={0} locale="ar" />);
    const arNum = ar.container.querySelector(".coupon-effective bdi")?.textContent;
    // ≤2 decimals, identical arithmetic EN⇄AR (spec §5).
    expect(enNum).toBe("SAR 474.05");
    expect(arNum).toBe(enNum);
  });

  it("buildCouponRows keys dedup per hop, picks the best SINGLE coupon, falls back honestly", () => {
    const offers = hopStamped.offers;
    const rows = buildCouponRows(
      [
        { code: "SAVEKD45", description: "10% off", discount: "10% off", expiresAt: null, merchant: "Jarir" },
        { code: "SAVEKD45", description: "KD 45 off", discount: "KD 45 off", expiresAt: null, merchant: "Jarir" },
        { code: "SAVEKD45", description: "10% off", discount: "10% off", expiresAt: null, merchant: "Xcite" },
      ],
      offers,
      null,
    );
    // Same code from two merchants stays TWO rows (per-hop dedup); inside one
    // retailer the BEST SINGLE coupon wins (largest delivered value), never a
    // stack — "KD 45 off" is not machine-readable, so "10% off" carries more.
    expect(rows.map((r) => `${r.merchant}:${r.coupon.discount}`)).toEqual([
      "Jarir:10% off",
      "Xcite:10% off",
    ]);
    // An unstamped record rides the card's cheapest ANSWERING merchant as its
    // attribution — an honest fallback, and that leading row owns the number.
    const stamped = buildCouponRows(
      [{ code: "X", description: "10% off", discount: "10% off", expiresAt: null }],
      offers,
      null,
    );
    expect(stamped).toHaveLength(1);
    expect(stamped[0].merchant).toBe("Jarir");
    expect(stamped[0].effectiveLabel).toBe("SAR 449.10");
  });
});

describe("REEA-541 Bet B — share-summary button placement", () => {
  it("rides the header of the results card AND the detail variant alike", () => {
    const list = render(<ProductResultCard product={product(false)} query="xm6" rank={0} />);
    expect(
      list.getByRole("button", { name: "Copy price comparison summary" }),
    ).toBeTruthy();
    cleanup();
    const detail = render(<ProductResultCard product={product(false)} variant="detail" />);
    expect(
      detail.getByRole("button", { name: "Copy price comparison summary" }),
    ).toBeTruthy();
  });
});

describe("REEA-540 Bet A — seen-recently confidence line", () => {
  const withRange = (): NormalizedProduct => ({
    ...product(false),
    seenRange: {
      min: { price: 4099, currency: "KWD" },
      max: { price: 4350, currency: "KWD" },
    },
  });

  it("the results card shows the range in EN, formatted like every other figure", () => {
    const { container } = render(
      <ProductResultCard product={withRange()} query="iphone 17 pro" rank={0} locale="en" />,
    );
    expect(container.textContent).toContain("Seen recently:");
    expect(container.textContent).toContain("KD 4,099\u2013KD 4,350");
    expect(container.textContent).toContain("last 14 days");
  });

  it("the Arabic locale rides the SAME line from the shared static table", () => {
    const { container } = render(
      <ProductResultCard product={withRange()} query="آيفون" rank={0} locale="ar" />,
    );
    expect(container.textContent).toContain("شوهد مؤخرًا:");
    // Figures keep the formatter's lead — only the chrome translates.
    expect(container.textContent).toContain("KD 4,099\u2013KD 4,350");
    expect(container.textContent).toContain("آخر 14 يومًا");
  });

  it("the detail variant keeps its hierarchy — the line does not ride it", () => {
    const { container } = render(
      <ProductResultCard product={withRange()} variant="detail" />,
    );
    expect(container.textContent).not.toContain("Seen recently:");
    expect(container.textContent).not.toContain("شوهد");
  });

  it("a thin window (field unset) renders NOTHING — never interpolated", () => {
    const { container } = render(
      <ProductResultCard product={product(false)} query="xm6" rank={0} />,
    );
    expect(container.textContent).not.toContain("Seen recently");
  });
});

describe("REEA-592 — Alternatives / Pairs-with rows (REEA-575 spec R2/R4)", () => {
  const base: NormalizedProduct = {
    productId: "apple-iphone-17-pro",
    title: "Apple iPhone 17 Pro",
    brand: "Apple",
    offers: [
      { merchant: "Xcite", price: 419, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [
      { productId: "apple-iphone-air", title: "Apple iPhone Air", fromPrice: 389 },
    ],
    pairsWith: [
      { productId: "apple-silicone-case", title: "Apple Silicone Case", fromPrice: 14.9 },
      { productId: "grabist-clear-case", title: "Grabist Clear Case", fromPrice: 75 },
    ],
    scrapedAt: "2026-09-10T00:00:00.000Z",
  };

  it("EN: comparables lead under Alternatives, capped complements under Pairs with", () => {
    const { container } = render(<ProductResultCard product={base} query="iphone 17 pro" rank={0} />);
    const selector = 'section[aria-label="Alternatives"], section[aria-label="Pairs with"]';
    const sections = Array.from(container.querySelectorAll(selector));
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Alternatives", "Pairs with"]);
    // Comparable row leads; the KD 14.90 case sits in its own capped row.
    const rows = sections.flatMap((s) => Array.from(s.querySelectorAll("a"))).map((a) => a.textContent);
    expect(rows).toEqual(["Apple iPhone Air", "Apple Silicone Case", "Grabist Clear Case"]);
  });

  it("AR: both labels are localized Arabic — raw English never leaks", () => {
    const { container } = render(
      <ProductResultCard product={base} query="آيفون 17" rank={0} locale="ar" />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("بدائل");
    expect(text).toContain("إكسسوارات مقترحة");
    expect(text).not.toContain("Pairs with");
    expect(text).not.toContain("Alternatives");
  });

  it("R4: zero-row cards contribute zero nodes — no dangling headings", () => {
    const empty: NormalizedProduct = { ...base, alternatives: [], pairsWith: [] };
    const { container } = render(<ProductResultCard product={empty} query="orstom" rank={0} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Alternatives");
    expect(text).not.toContain("Pairs with");
    expect(text).not.toContain("بدائل");
  });
});

describe("REEA-721 — heading `from` figure: matching offers only, KD-space, <=2 decimals", () => {
  const stamp = "2026-09-11T08:00:00.000Z";

  it("the from-line rounds half-expand at hundredths (0.48861 -> KD 0.49)", () => {
    const { container } = render(
      <ProductResultCard
        product={{
          productId: "tiny-fee",
          title: "Anker USB-C Cable 1m",
          brand: "Anker",
          offers: [{ merchant: "Blink", price: 0.48861, currency: "KWD", url: "https://blink.example/c", inStock: true }],
          coupons: [],
          variations: [],
          alternatives: [],
          scrapedAt: stamp,
        }}
        query="anker cable"
        rank={0}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("KD 0.49");
    expect(text).not.toContain("KD 0.488");
  });

  it("the figure is the cheapest EFFECTIVE value over the card's matching offers, in KD-space", () => {
    // Two live rows of ONE product: the SAR listing converts to KD-space and
    // wins the comparison (0.816 against KD 1.25) — the heading states the
    // comparable figure whatever order the rows arrive in. The hero row
    // still prints its scraped figure beside the ≈ twin (REEA-283).
    const { container } = render(
      <ProductResultCard
        product={{
          productId: "anker-charger",
          title: "Anker 310 Compact Charger",
          brand: "Anker",
          offers: [
            { merchant: "Jarir", price: 10, currency: "SAR", url: "https://jarir.example/ch", inStock: true },
            { merchant: "Xcite", price: 1.25, currency: "KWD", url: "https://xcite.example/ch", inStock: true },
          ],
          coupons: [],
          variations: [],
          alternatives: [],
          scrapedAt: stamp,
        }}
        query="anker charger"
        rank={0}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("KD 0.82");
    // EN and AR run the identical arithmetic (parity bar).
    cleanup();
    const ar = render(
      <ProductResultCard
        product={{
          productId: "anker-charger",
          title: "شاحن انكر 310",
          brand: "Anker",
          offers: [
            { merchant: "Jarir", price: 10, currency: "SAR", url: "https://jarir.example/ch", inStock: true },
            { merchant: "Xcite", price: 1.25, currency: "KWD", url: "https://xcite.example/ch", inStock: true },
          ],
          coupons: [],
          variations: [],
          alternatives: [],
          scrapedAt: stamp,
        }}
        query="شاحن انكر"
        rank={0}
        locale="ar"
      />,
    );
    expect(ar.container.textContent ?? "").toContain("KD 0.82");
  });
});
