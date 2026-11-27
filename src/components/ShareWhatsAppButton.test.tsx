// @vitest-environment jsdom
/**
 * REEA-1255 AC1/AC4/AC5 — the rendered WhatsApp share entry point.
 *
 * The anchor must be a real link (keyboard reachable, new tab) carrying the
 * locale-appropriate accessible name and the `https://wa.me/?text=` href the
 * committed probe decodes. The click fires the aggregate-only counter.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShareWhatsAppButton from "@/components/ShareWhatsAppButton";
import { trackEvent } from "@/lib/telemetry";
import type { NormalizedProduct } from "@/types/product";

vi.mock("@/lib/telemetry", () => ({ trackEvent: vi.fn(), trackEvents: vi.fn() }));

afterEach(() => cleanup());

function product(): NormalizedProduct {
  return {
    productId: "apple-iphone-15",
    title: "Apple iPhone 15",
    brand: "Apple",
    offers: [
      { merchant: "Xcite", price: 129, currency: "KWD", url: "https://xcite.example/p", inStock: true },
      { merchant: "Jarir", price: 139, currency: "KWD", url: "https://jarir.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-27T00:00:00.000Z",
  };
}

const PAGE_URL = "https://ns539626.ip-144-217-72.net/results?q=iphone%2015";

describe("REEA-1255 AC1 — rendered WhatsApp anchor", () => {
  it("renders a keyboard-reachable anchor that opens wa.me in a new tab", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton
        products={[product()]}
        query="iphone 15"
        pageUrl={PAGE_URL}
        country="KW"
        locale="en"
      />,
    );
    const link = getByRole("link", { name: "Share on WhatsApp" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("data-share-whatsapp")).toBe("true");
    // 44px tap floor comes from the shared control class.
    expect(link.className).toContain("query-pill");
    expect(link.textContent).toContain("Share");
    const decoded = decodeURIComponent((link.getAttribute("href") ?? "").split("text=")[1] ?? "");
    expect(decoded).toContain("iphone 15");
    expect(decoded).toContain("Xcite KD 129");
    expect(decoded).toContain(PAGE_URL);
  });

  it("carries the Arabic accessible name and label in AR", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton
        products={[product()]}
        query="آيفون 15"
        pageUrl="https://ns539626.ip-144-217-72.net/results?q=%D8%A2%D9%8A%D9%81%D9%88%D9%86%2015"
        country="KW"
        locale="ar"
      />,
    );
    const link = getByRole("link", { name: "شارك على واتساب" });
    expect(link.textContent).toContain("شارك");
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain("ريمكو");
  });

  it("icon-only variant keeps the same href and 44x44 control class", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton
        products={[product()]}
        query="iphone 15"
        pageUrl={PAGE_URL}
        country="KW"
        locale="en"
        iconOnly
      />,
    );
    const link = getByRole("link", { name: "Share on WhatsApp" });
    expect(link.className).toContain("rc-icon-btn");
    expect(link.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });
});

describe("REEA-1255 AC5(b) — aggregate share_whatsapp click", () => {
  it("fires exactly one type-only event per click", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton
        products={[product()]}
        query="iphone 15"
        pageUrl={PAGE_URL}
        country="KW"
        locale="en"
      />,
    );
    fireEvent.click(getByRole("link", { name: "Share on WhatsApp" }));
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith({ type: "share_whatsapp" });
  });
});
