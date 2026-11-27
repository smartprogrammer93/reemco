// @vitest-environment jsdom
/**
 * REEA-1255 AC1/AC4/AC5 — the rendered WhatsApp share entry point,
 * implemented to the REEA-1257 spec §4/§5/§8.
 *
 * The anchor must be a real link (keyboard reachable, new tab), carry the
 * spec-pinned accessible name and the server-rendered message in
 * `data-share-message`; the click increments the aggregate counter, and the
 * blocked-window fallback copies that exact message (never DOM-scraped text).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareWhatsAppButton from "@/components/ShareWhatsAppButton";
import { trackEvent } from "@/lib/telemetry";
import type { NormalizedProduct } from "@/types/product";

vi.mock("@/lib/telemetry", () => ({ trackEvent: vi.fn(), trackEvents: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

function product(): NormalizedProduct {
  return {
    productId: "apple-iphone15",
    title: "Apple iPhone 15, 128GB",
    brand: "Apple",
    offers: [
      { merchant: "Xcite", price: 204.9, currency: "KWD", url: "https://xcite.example/p", inStock: true },
      { merchant: "Yousifi", price: 205.9, currency: "KWD", url: "https://yousifi.example/p", inStock: true },
      { merchant: "Eureka", price: 239.9, currency: "KWD", url: "https://eureka.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-27T00:00:00.000Z",
  };
}

const ORIGIN = "https://ns539626.ip-144-217-72.net";

describe("REEA-1255 AC1 — rendered WhatsApp anchor", () => {
  it("card: a keyboard-reachable anchor that opens wa.me in a new tab", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton product={product()} query="iphone 15" origin={ORIGIN} locale="en" variant="card" />,
    );
    const link = getByRole("link", { name: "Share on WhatsApp" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("data-share-whatsapp")).toBe("true");
    expect(link.className).toContain("rc-share-wa");
    expect(link.className).toContain("rc-share-wa--card");
    const message = link.getAttribute("data-share-message") ?? "";
    expect(message).toContain("Apple iPhone 15, 128GB — Kuwait price check");
    expect(message).toContain("1. Xcite KD 204.90");
    expect(message).toContain(`${ORIGIN}/product/apple-iphone15?q=iphone%2015`);
  });

  it("PDP: pill label and the spec-pinned accessible name in EN", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton product={product()} query="iphone 15" origin={ORIGIN} locale="en" variant="pdp" />,
    );
    const link = getByRole("link", { name: "Share this comparison on WhatsApp" });
    expect(link.textContent).toContain("WhatsApp");
    expect(link.className).toContain("rc-share-wa--pdp");
  });

  it("PDP: Arabic accessible name and visible label", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton product={product()} query="iphone 15" origin={ORIGIN} locale="ar" variant="pdp" />,
    );
    const link = getByRole("link", { name: "شارك هذه المقارنة عبر واتساب" });
    expect(link.textContent).toContain("واتساب");
    expect(link.getAttribute("data-share-message")).toContain("مقارنة أسعار في الكويت");
  });

  it("loading: aria-disabled and the loading accessible name", () => {
    const { getByRole } = render(
      <ShareWhatsAppButton product={product()} origin={ORIGIN} locale="en" variant="card" loading />,
    );
    const link = getByRole("link", { name: "Share when prices load" });
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.className).toContain("rc-share-wa");
  });
});

describe("REEA-1255 AC5(b) — aggregate share_whatsapp click", () => {
  it("fires exactly one type-only event per click", () => {
    vi.spyOn(window, "open").mockReturnValue({ opener: null } as unknown as Window);
    const { getByRole } = render(
      <ShareWhatsAppButton product={product()} query="iphone 15" origin={ORIGIN} locale="en" variant="card" />,
    );
    fireEvent.click(getByRole("link", { name: "Share on WhatsApp" }));
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith({ type: "share_whatsapp" });
  });
});

describe("REEA-1257 §4 — copied / copy-failed fallback", () => {
  it("copies the server-rendered message when the WhatsApp window is blocked", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { getByRole, container } = render(
      <ShareWhatsAppButton product={product()} query="iphone 15" origin={ORIGIN} locale="en" variant="pdp" />,
    );
    const link = getByRole("link", { name: "Share this comparison on WhatsApp" });
    const message = link.getAttribute("data-share-message") ?? "";
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(message));
    await waitFor(() => expect(link.textContent).toContain("Copied"));
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Copied — paste in WhatsApp",
    );
  });

  it("reveals a selectable output with the message when the clipboard rejects", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const { getByRole, container } = render(
      <ShareWhatsAppButton product={product()} query="iphone 15" origin={ORIGIN} locale="en" variant="card" />,
    );
    fireEvent.click(getByRole("link", { name: "Share on WhatsApp" }));
    await waitFor(() => expect(container.querySelector("output")?.textContent).toContain("Kuwait price check"));
  });
});
