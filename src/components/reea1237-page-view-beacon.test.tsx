// @vitest-environment jsdom
/**
 * REEA-1237 — the client page-view beacon: exactly one beacon per served
 * results page, no identifier in the event.
 *
 * The smallest proving check for the shopper CTR denominator: mount the
 * beacon the results page renders, then assert (a) one `page_view` per serve,
 * (b) no double-fire on a re-render of the same serve, (c) a new server
 * render (new query / refresh) fires again, and (d) the emitted event carries
 * ONLY the type — no query, no serve key, no session/user id (AC-5) — and is
 * accepted by the same validation the ingestion route runs.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultsPageViewBeacon from "@/components/ResultsPageViewBeacon";
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

describe("REEA-1237 results page-view beacon", () => {
  it("fires exactly one page_view for a served results page", () => {
    render(<ResultsPageViewBeacon serveKey="serve-1" />);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: "page_view" });
  });

  it("does not double-fire on a re-render of the SAME serve", () => {
    const { rerender } = render(<ResultsPageViewBeacon serveKey="serve-1" />);
    rerender(<ResultsPageViewBeacon serveKey="serve-1" />);
    rerender(<ResultsPageViewBeacon serveKey="serve-1" />);
    expect(sent.filter((e) => e.type === "page_view")).toHaveLength(1);
  });

  it("fires again when the server render changes (new query or refresh)", () => {
    const { rerender } = render(<ResultsPageViewBeacon serveKey="serve-1" />);
    rerender(<ResultsPageViewBeacon serveKey="serve-2" />);
    expect(sent.filter((e) => e.type === "page_view")).toHaveLength(2);
  });

  it("stores no identifier: the event is the type only, and the route accepts it", () => {
    render(<ResultsPageViewBeacon serveKey="serve-1" />);
    expect(Object.keys(sent[0])).toEqual(["type"]);
    expect(sent[0].type).toBe("page_view");
    expect(validateEvent(sent[0]).ok).toBe(true);
  });

  it("renders nothing and never throws into the page", () => {
    const { container } = render(<ResultsPageViewBeacon serveKey="serve-1" />);
    expect(container.innerHTML).toBe("");
  });
});
