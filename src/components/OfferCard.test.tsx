// @vitest-environment jsdom
/**
 * REEA-224 F2 — OfferCard must pass scraped offer URLs through the shared
 * render-time sanitizer (safeHref) exactly like ProductResultCard's chain:
 * healthy retailer URLs land verbatim; a crafted scheme never reaches the
 * anchor as an executable href.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import OfferCard from "@/components/OfferCard";

afterEach(cleanup);

const baseProps = {
  merchant: "Xcite",
  priceLabel: "KD 29.90",
  inStock: true,
  collectedAt: "2026-09-05T21:00:00Z",
  method: "live" as const,
  isBest: false,
  savings: null,
};

describe("OfferCard outbound href (REEA-224 F2)", () => {
  it("renders a healthy scraped offer URL through the shared allowlist", () => {
    const { container } = render(
      <OfferCard {...baseProps} url="https://www.xcite.com/airpods-pro-2/p" />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.xcite.com/airpods-pro-2/p",
    );
  });

  it("sanitizes a crafted scheme to an empty href", () => {
    const { container } = render(<OfferCard {...baseProps} url="javascript:alert(1)" />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("");
  });
});

describe("OfferCard absolute freshness stamp (REEA-759)", () => {
  it("pairs the relative chip with the absolute collection moment", () => {
    const { container } = render(
      <OfferCard {...baseProps} url="https://www.xcite.com/airpods-pro-2/p" />,
    );
    // Relative side: the fresh-chip grammar stays intact.
    expect(container.querySelector(".fresh-chip")).not.toBeNull();
    // Absolute side: the meta-stamp line carries the locale-invariant stamp,
    // <bdi>-isolated for RTL chrome.
    const stamp = container.querySelector(".meta-stamp");
    expect(stamp?.textContent).toBe("2026-09-05 21:00 UTC");
    expect(stamp?.querySelector("bdi")).not.toBeNull();
  });

  it("renders no absolute line when the stamp is missing or invalid", () => {
    const { container } = render(
      <OfferCard {...baseProps} collectedAt="not-a-date" url="https://www.xcite.com/p" />,
    );
    expect(container.querySelector(".meta-stamp")).toBeNull();
  });
});
