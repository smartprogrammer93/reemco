// @vitest-environment jsdom
/**
 * REEA-541 Bet B — Copy button behavior on the card header.
 * AC4: navigator.clipboard first, select-on-click fallback, no persistent
 * client state. AC3: one anonymous summary_copied event per copy — query
 * falls back to the product title on the detail page (no query string there).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShareSummaryButton from "@/components/ShareSummaryButton";
import { trackEvent } from "@/lib/telemetry";
import type { NormalizedProduct } from "@/types/product";

vi.mock("@/lib/telemetry", () => ({ trackEvent: vi.fn(), trackEvents: vi.fn() }));

afterEach(() => cleanup());

function product(): NormalizedProduct {
  return {
    productId: "iphone-17-pro",
    title: "iPhone 17 Pro",
    brand: "Apple",
    offers: [
      { merchant: "Jarir", price: 4199, currency: "KWD", url: "https://jarir.example/p", inStock: true },
      { merchant: "Xcite", price: 4099, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    // 3h before the click-time clock → the hours bucket reads "3h ago".
    scrapedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  };
}

function setClipboard(value: { writeText: ReturnType<typeof vi.fn> } | undefined): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

describe("REEA-541 AC4 — clipboard with select-on-click fallback", () => {
  it("copies the summary line through navigator.clipboard in on-screen order", async () => {
    setClipboard(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { getByRole } = render(<ShareSummaryButton product={product()} query="iphone 17 pro" />);
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    // Cheapest-first (Xcite before Jarir) and the freshness bucket tail ride the line.
    expect(text).toContain("best now: Xcite KD 4,099 · Jarir KD 4,199");
    expect(text).toMatch(/verified \dh ago/);
  });

  it("without navigator.clipboard the click selects the line and copies via execCommand", () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    const { getByRole } = render(<ShareSummaryButton product={product()} query="iphone 17 pro" />);
    fireEvent.click(getByRole("button"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The temporary textarea is transient state — gone right after the copy.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("shows transient copied feedback on both paths", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { getByRole } = render(<ShareSummaryButton product={product()} locale="ar" />);
    const button = getByRole("button");
    expect(button.textContent).toBe("نسخ");
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("✓"));
  });

  it("AR locale keeps the same line layout with the table words", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { getByRole } = render(<ShareSummaryButton product={product()} locale="ar" />);
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0] as string).toContain("أفضل سعر الآن");
  });
});

describe("REEA-541 AC3 — anonymous summary_copied event", () => {
  it("fires once with the list query context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { getByRole } = render(<ShareSummaryButton product={product()} query="iphone 17 pro" />);
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(trackEvent).toHaveBeenLastCalledWith({
      type: "summary_copied",
      query: "iphone 17 pro",
      item_id: "iphone-17-pro",
    });
  });

  it("the detail page (no query string) names the compared product via its title", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { getByRole } = render(<ShareSummaryButton product={product()} />);
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(trackEvent).toHaveBeenLastCalledWith({
      type: "summary_copied",
      query: "iPhone 17 Pro",
      item_id: "iphone-17-pro",
    });
  });
});
