// @vitest-environment jsdom
/**
 * REEA-1100 AC1/AC2/AC4 — the results-grid lead-card CTA age and the legacy
 * offer-row age must render through the localizedAgePair ladder
 * (localizedAgeFromStamp), never a raw "0s ago"/"12s ago" token. QA measured
 * exactly one raw `\d+s ago` per EN results page on the Shelf build
 * 50cc3ae; REEA-1095 fixed only the product-page note.
 *
 * These pins cover the rendered card in EN and AR, the served first paint
 * (no effects), the negative `\d+s ago` assertion, and the invalid-stamp
 * fallback to the existing localized unknown copy (never "just now").
 */
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import { LiveAge } from "@/components/OfferCtaLabel";
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

// Real-clock base, same discipline as the REEA-930 CTA suite: the live
// ticker in LiveAge re-reads Date.now() after mount, so the fixtures ride
// the current clock instead of a frozen date.
const BASE = Date.now();
const FRESH_AT = new Date(BASE - 5_000).toISOString();
const FOUR_MIN_AT = new Date(BASE - 4 * 60_000).toISOString();
const TWO_HOUR_AT = new Date(BASE - 2 * 3_600_000).toISOString();

function product(collectedAt: string): NormalizedProduct {
  return {
    productId: "reea1100-probe",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers: [
      {
        merchant: "Xcite",
        price: 333.9,
        currency: "KWD",
        url: "https://www.xcite.com/apple-iphone-17-pro/p",
        inStock: true,
        collectedAt,
      },
      {
        merchant: "Eureka",
        price: 349,
        currency: "KWD",
        url: "https://www.eureka.com/apple-iphone-17-pro/p",
        inStock: true,
        collectedAt,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: collectedAt,
  };
}

function renderCard(locale: "en" | "ar", collectedAt: string) {
  return render(
    <ProductResultCard
      product={product(collectedAt)}
      isBest
      query="iphone 17 pro"
      rank={0}
      renderStartMs={BASE}
      locale={locale}
    />,
  );
}

function ctaAge(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".cta-lead-age");
}

function rowChecked(container: HTMLElement): string {
  return (container.querySelector("li.offer-row .rc-checked")?.textContent ?? "").trim();
}

describe("REEA-1100 AC1/AC2 — results lead-card CTA age is humanised/localised", () => {
  it("EN sub-minute reads just now, never a raw 0s/5s token", () => {
    const { container } = renderCard("en", FRESH_AT);
    expect(ctaAge(container)?.textContent).toContain("Checked just now");
    expect(container.textContent).not.toMatch(/\b\d+s ago/);
  });

  it("AR sub-minute reads الآن with no Latin s ago fragment", () => {
    const { container } = renderCard("ar", FRESH_AT);
    expect(ctaAge(container)?.textContent).toContain("تم التحقق الآن");
    expect(ctaAge(container)?.textContent).not.toMatch(/s ago/);
    expect(container.textContent).not.toMatch(/\b\d+s ago/);
  });

  it("EN minute/hour stamps render the humanised ladder", () => {
    const minute = renderCard("en", FOUR_MIN_AT);
    expect(ctaAge(minute.container)?.textContent).toContain("Checked 4 min ago");
    expect(minute.container.textContent).not.toMatch(/\b\d+s ago/);
    cleanup();

    const hours = renderCard("en", TWO_HOUR_AT);
    expect(ctaAge(hours.container)?.textContent).toContain("Checked 2 hr ago");
    expect(hours.container.textContent).not.toMatch(/\b\d+s ago/);
  });

  it("AR minute/hour stamps render Arabic dual/plural copy, not a Latin suffix", () => {
    const minute = renderCard("ar", FOUR_MIN_AT);
    expect(ctaAge(minute.container)?.textContent).toContain("تم التحقق قبل 4 دقائق");
    expect(minute.container.textContent).not.toMatch(/s ago/);
    expect(minute.container.textContent).not.toMatch(/\b\d+s ago/);
    cleanup();

    const hours = renderCard("ar", TWO_HOUR_AT);
    expect(ctaAge(hours.container)?.textContent).toContain("تم التحقق قبل ساعتين");
    expect(hours.container.textContent).not.toMatch(/s ago/);
  });

  it("keeps the existing CTA age slot and class (no layout hook change)", () => {
    const { container } = renderCard("en", FRESH_AT);
    const age = ctaAge(container);
    expect(age).not.toBeNull();
    expect(age?.querySelector("span.tabular")).not.toBeNull();
    expect(age?.closest(".cta-lead")).toBe(container.querySelector(".cta-lead"));
  });
});

describe("REEA-1100 — served first paint (no effects) is already humanised", () => {
  it("LiveAge initial render is just now / الآن, not 0s ago", () => {
    expect(renderToStaticMarkup(<LiveAge collectedAt={FRESH_AT} initialSeconds={5} locale="en" />)).toContain(
      "just now",
    );
    expect(renderToStaticMarkup(<LiveAge collectedAt={FRESH_AT} initialSeconds={5} locale="en" />)).not.toMatch(
      /\d+s ago/,
    );
    expect(renderToStaticMarkup(<LiveAge collectedAt={FRESH_AT} initialSeconds={5} locale="ar" />)).toContain(
      "الآن",
    );
    expect(renderToStaticMarkup(<LiveAge collectedAt={FRESH_AT} initialSeconds={5} locale="ar" />)).not.toMatch(
      /s ago/,
    );
  });
});

describe("REEA-1100 — legacy offer-row age", () => {
  it("EN row reads Checked just now / Checked 4 min ago, never raw seconds", () => {
    const fresh = renderCard("en", FRESH_AT);
    expect(rowChecked(fresh.container)).toBe("Checked just now");
    expect(fresh.container.textContent).not.toMatch(/\b\d+s ago/);
    cleanup();

    const minute = renderCard("en", FOUR_MIN_AT);
    expect(rowChecked(minute.container)).toBe("Checked 4 min ago");
    expect(minute.container.textContent).not.toMatch(/\b\d+s ago/);
  });

  it("AR row reads حُدِّث الآن / حُدِّث قبل 4 دقائق, never a Latin s ago", () => {
    const fresh = renderCard("ar", FRESH_AT);
    expect(rowChecked(fresh.container)).toBe("حُدِّث الآن");
    expect(fresh.container.textContent).not.toMatch(/s ago/);
    cleanup();

    const minute = renderCard("ar", FOUR_MIN_AT);
    expect(rowChecked(minute.container)).toBe("حُدِّث قبل 4 دقائق");
    expect(minute.container.textContent).not.toMatch(/s ago/);
  });
});

describe("REEA-1100 — invalid stamps keep the localized unknown copy", () => {
  it("EN invalid stamp: no CTA age line, row says date unknown, never just now", () => {
    const { container } = renderCard("en", "not-a-date");
    expect(ctaAge(container)).toBeNull();
    expect(rowChecked(container)).toBe("date unknown");
    expect(rowChecked(container)).not.toContain("just now");
    expect(container.textContent).not.toMatch(/\b\d+s ago/);
  });

  it("AR invalid stamp: row says وقت غير معروف, never الآن", () => {
    const { container } = renderCard("ar", "not-a-date");
    expect(ctaAge(container)).toBeNull();
    expect(rowChecked(container)).toBe("وقت غير معروف");
    expect(rowChecked(container)).not.toContain("الآن");
    expect(container.textContent).not.toMatch(/s ago/);
  });

  it("LiveAge direct invalid stamp renders the localized unknown copy", () => {
    expect(renderToStaticMarkup(<LiveAge collectedAt="not-a-date" initialSeconds={0} locale="en" />)).toBe(
      '<span class="tabular">date unknown</span>',
    );
    expect(renderToStaticMarkup(<LiveAge collectedAt="not-a-date" initialSeconds={0} locale="ar" />)).toBe(
      '<span class="tabular">وقت غير معروف</span>',
    );
  });
});
