// @vitest-environment jsdom
/**
 * REEA-1078 — click-counter coverage for queryless offer CTAs.
 *
 * The product-detail page's offer rows are real offer clicks with no shopper
 * query (the page was reached by product id). Before this fix the CTA sent
 * `query: ""`, which the funnel schema rejected, so those clicks never
 * incremented `offer_link_clicks`. The smallest proving check: render the
 * queryless link, click it, and assert the emitted event (a) omits the empty
 * query and (b) passes the SAME validation the ingestion route applies — i.e.
 * it lands in the funnel store the weekly counter reads.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { validateEvent } from "@/lib/events";
import type { ClientEvent } from "@/lib/telemetry";

const sent: ClientEvent[] = [];

vi.mock("@/lib/telemetry", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/telemetry")>();
  return {
    ...mod,
    trackEvent: vi.fn((ev: ClientEvent) => {
      sent.push(ev);
    }),
    trackEvents: vi.fn((events: ClientEvent[]) => {
      sent.push(...events);
    }),
  };
});

afterEach(() => {
  cleanup();
  sent.length = 0;
  vi.clearAllMocks();
});

describe("REEA-1078 queryless offer CTA click", () => {
  it("emits an item_clicked event the ingestion schema accepts (no empty query)", () => {
    const { getByText } = render(
      <TrackedOutboundLink
        href="https://www.xcite.com/p/1"
        query=""
        rank={0}
        itemId="prod-1"
        className="cta"
      >
        View at Xcite
      </TrackedOutboundLink>,
    );
    fireEvent.click(getByText("View at Xcite"));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("item_clicked");
    expect(sent[0].query).toBeUndefined();
    // Same validation the /api/events route runs: the click lands.
    expect(validateEvent(sent[0]).ok).toBe(true);
  });

  it("keeps the shopper query on a query-carrying results-card CTA", () => {
    const { getByText } = render(
      <TrackedOutboundLink
        href="https://www.jarir.com/p/1"
        query="iphone 17"
        rank={2}
        itemId="prod-2"
        className="cta"
      >
        Go to store
      </TrackedOutboundLink>,
    );
    fireEvent.click(getByText("Go to store"));
    expect(sent[0]).toMatchObject({ type: "item_clicked", query: "iphone 17", rank: 2 });
    expect(validateEvent(sent[0]).ok).toBe(true);
  });
});
