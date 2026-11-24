// @vitest-environment jsdom
/**
 * REEA-1128 — ProxyRetryImage, the client half of the Shopify-photo fix.
 *
 * The proxy route cannot ride out a multi-second refusal wave without leaving
 * the card frame blank, so it answers a miss with a 1x1-intrinsic SVG glyph
 * and this component re-requests the photo on a backoff. jsdom does not load
 * images, so the tests drive the decoded size themselves: `naturalWidth` 1 is
 * the miss glyph, anything wider is a real photo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import ProxyRetryImage from "@/components/ProxyRetryImage";

const SRC = "/api/image?u=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fa.jpg";

function renderImage() {
  const { container } = render(<ProxyRetryImage src={SRC} alt="product image" width={160} height={160} />);
  const img = container.querySelector("img");
  if (!img) throw new Error("ProxyRetryImage rendered no img");
  return img;
}

/** next/image resolves a relative src against the jsdom origin; grade the path. */
function srcOf(img: HTMLImageElement): string {
  return (img.getAttribute("src") ?? "").replace(/^https?:\/\/[^/]+/, "");
}

function settle(img: HTMLImageElement, naturalWidth: number) {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: naturalWidth });
  Object.defineProperty(img, "complete", { configurable: true, value: true });
  fireEvent.load(img);
}

describe("REEA-1128 — a proxied photo re-requests itself after a proxy miss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a decoded product photo alone", () => {
    const img = renderImage();
    expect(srcOf(img)).toBe(SRC);
    settle(img, 800);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(srcOf(img)).toBe(SRC);
  });

  it("retries a 1x1 miss glyph with a distinct cache-busting stamp", () => {
    const img = renderImage();
    settle(img, 1);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=1`);

    settle(img, 1);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=2`);

    settle(img, 1);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=3`);
  });

  it("stops after the third retry and stays on the glyph", () => {
    const img = renderImage();
    settle(img, 1);
    for (const delay of [1200, 3500, 8000]) {
      act(() => {
        vi.advanceTimersByTime(delay);
      });
      settle(img, 1);
    }
    expect(srcOf(img)).toBe(`${SRC}&r=3`);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=3`);
  });

  it("stops retrying once the real photo arrives", () => {
    const img = renderImage();
    settle(img, 1);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=1`);
    settle(img, 800);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=1`);
  });

  it("treats a failed load as a miss and schedules the same backoff", () => {
    const img = renderImage();
    fireEvent.error(img);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=1`);
  });

  it("never schedules two retries for one attempt", () => {
    const img = renderImage();
    settle(img, 1);
    settle(img, 1);
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(srcOf(img)).toBe(SRC);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(srcOf(img)).toBe(`${SRC}&r=1`);
  });
});
