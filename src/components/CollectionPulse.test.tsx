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
    expect(container.querySelector(".pulse-spinner")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Timed out")).toBeNull();
    expect(screen.getByText("2 offers")).toBeTruthy();
  });

  it("snaps the bar green when settled", () => {
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
    expect(container.querySelector(".pulse-bar-fill.is-done")).toBeTruthy();
    expect(screen.getByText("Collection complete")).toBeTruthy();
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

  it("badges the best offer, shows provenance on every card", () => {
    render(<PulseOfferCascade offers={offers} />);
    const badges = screen.getAllByText("Best price");
    expect(badges.length).toBe(1);
    expect(screen.getByText(/vs highest/)).toBeTruthy();
    expect(screen.getAllByText(/· (live|cached)/).length).toBe(2);
  });

  it("never invents savings when there is a single offer", () => {
    render(<PulseOfferCascade offers={[offers[0]]} />);
    expect(screen.queryByText(/Save /)).toBeNull();
  });
});
