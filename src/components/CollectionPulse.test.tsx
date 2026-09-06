// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import CollectionPulse, { PulseOfferCascade } from "@/components/CollectionPulse";
import type { CollectJob } from "@/lib/collect/types";

afterEach(cleanup);

const startedAt = "2026-09-05T21:00:00Z";

function runningJob(): CollectJob {
  return {
    jobId: "j1",
    productId: "p1",
    status: "collecting",
    mode: "live",
    startedAt,
    offers: [],
    subtasks: [
      { retailer: "xcite", domain: "xcite.com", status: "done", offersFound: 2 },
      { retailer: "eureka", domain: "eureka.com.kw", status: "collecting", offersFound: 0 },
      { retailer: "sultan-center", domain: "sultan-center.com", status: "pending", offersFound: 0 },
      { retailer: "darbe", domain: "darbe.com", status: "failed", offersFound: 0, error: "blocked" },
    ],
  };
}

describe("CollectionPulse (plan §2.6, REEA-90 C8)", () => {
  it("renders real subtask states — spinner for collecting, failure chip for failed", () => {
    const { container } = render(<CollectionPulse job={runningJob()} elapsedLabel="12s" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(container.querySelector(".rc-chip-rail")).toBeTruthy();
    expect(container.querySelector(".pulse-spinner")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Timed out")).toBeNull();
    expect(screen.getByText("2 offers")).toBeTruthy();
  });

  it("collapses the rail once settled and shows the completion caption", () => {
    const done: CollectJob = {
      ...runningJob(),
      status: "complete",
      subtasks: runningJob().subtasks.map((s) =>
        s.status === "collecting" || s.status === "pending"
          ? { ...s, status: "done", offersFound: 1 }
          : s,
      ),
    };
    const { container } = render(<CollectionPulse job={done} />);
    expect(screen.getByText("Collection complete")).toBeTruthy();
    // Signature rail collapses when every slot is filled (design-v3 §5.6).
    expect(container.querySelector(".pulse-bar-fill")).toBeNull();
  });
});

describe("PulseOfferCascade", () => {
  const offers = [
    {
      merchant: "Xcite",
      domain: "xcite.com",
      price: 100,
      currency: "KWD",
      url: "https://xcite.com/p",
      inStock: true,
      collectedAt: startedAt,
      method: "live" as const,
    },
    {
      merchant: "Eureka",
      domain: "eureka.com.kw",
      price: 112.4,
      currency: "KWD",
      url: "https://eureka.com.kw/p",
      inStock: true,
      collectedAt: startedAt,
      method: "cache" as const,
    },
  ];

  it("badges the best offer with a savings pill, shows provenance on every card", () => {
    const { container } = render(<PulseOfferCascade offers={offers} />);
    const badges = screen.getAllByText("Best price");
    expect(badges.length).toBe(1);
    // Savings emphasis (design-v3 §5.3): pill directly after the best price.
    expect(screen.getByText(/^Save /)).toBeTruthy();
    // Provenance chip on EVERY card (§5.5), live vs cache labeled.
    expect(container.querySelectorAll(".fresh-chip").length).toBe(2);
    expect(container.textContent).toMatch(/live/);
    expect(container.textContent).toMatch(/cached/);
  });

  it("never invents savings when there is a single offer", () => {
    render(<PulseOfferCascade offers={[offers[0]]} />);
    expect(screen.queryByText(/Save /)).toBeNull();
  });
});
