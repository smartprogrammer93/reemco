// @vitest-environment jsdom
/**
 * REEA-965 — v1 click instrumentation on the results card (spec FR-3, AC-5).
 *
 * The smallest proving check for the click path: a results card carrying the
 * server render's queryId fires `result_click` on an outbound CTA click,
 * `first_result_click` exactly on the first primary card (position 1), and
 * NEITHER on surfaces without the v1 context (no queryId → the REEA-37
 * funnel event only). The click handler never awaits anything (AC-9 by
 * construction — the beacon helpers are synchronous fire-and-forget).
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductResultCard from "@/components/ProductResultCard";
import type { NormalizedProduct } from "@/types/product";
import type { ClientEvent } from "@/lib/telemetry";

const sent: ClientEvent[] = [];

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

function product(title: string, productId: string): NormalizedProduct {
  return {
    productId,
    title,
    brand: "Sony",
    offers: [
      { merchant: "Xcite", price: 364.9, currency: "KWD", url: "https://xcite.example/p", inStock: true, collectedAt: "2026-09-14T00:00:00.000Z" },
      { merchant: "Jarir", price: 374.9, currency: "KWD", url: "https://jarir.example/p", inStock: true, collectedAt: "2026-09-14T00:00:00.000Z" },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-14T00:00:00.000Z",
  };
}

function clickLeadCta(scope: ParentNode): HTMLAnchorElement {
  // The lead CTA is the card's one primary action (REEA-930) — an <a>.
  const link = scope.querySelector<HTMLAnchorElement>("a.cta-lead");
  expect(link).not.toBeNull();
  fireEvent.click(link as HTMLAnchorElement);
  return link as HTMLAnchorElement;
}

describe("v1 result_click instrumentation (REEA-965)", () => {
  it("first primary card click fires item_clicked + result_click + first_result_click (position 1)", () => {
    render(
      <ProductResultCard
        product={product("Sony WH-1000XM6", "p1")}
        isBest
        query="sony wh-1000xm6"
        rank={0}
        queryId="qid-1"
      />,
    );
    clickLeadCta(document.body);
    const types = sent.map((e) => e.type);
    expect(types).toContain("item_clicked");
    expect(types).toContain("result_click");
    expect(types).toContain("first_result_click");
    expect(sent.find((e) => e.type === "result_click")).toMatchObject({
      queryId: "qid-1",
      offerId: "p1",
      retailer: "Xcite", // the lead offer's merchant — the CTA's destination
      position: 1,
      schema: 1,
    });
    expect(sent.find((e) => e.type === "first_result_click")).toMatchObject({
      position: 1,
      queryId: "qid-1",
      offerId: "p1",
      schema: 1,
    });
  });

  it("a later primary card fires result_click with its position but no first_result_click", () => {
    render(
      <ProductResultCard
        product={product("Sony WH-1000XM6", "p2")}
        isBest
        query="sony wh-1000xm6"
        rank={3}
        queryId="qid-1"
      />,
    );
    clickLeadCta(document.body);
    expect(sent.map((e) => e.type)).toContain("result_click");
    expect(sent.map((e) => e.type)).not.toContain("first_result_click");
    expect(sent.find((e) => e.type === "result_click")).toMatchObject({ position: 4 });
  });

  it("without the v1 context (no queryId) the card keeps the funnel event only", () => {
    render(<ProductResultCard product={product("Sony WH-1000XM6", "p1")} isBest query="sony" rank={0} />);
    clickLeadCta(document.body);
    expect(sent.map((e) => e.type)).toContain("item_clicked");
    expect(sent.filter((e) => e.type === "result_click")).toHaveLength(0);
    expect(sent.filter((e) => e.type === "first_result_click")).toHaveLength(0);
  });

  it("an offer-row button attributes the click to its own merchant, same card position", () => {
    render(
      <ProductResultCard
        product={product("Sony WH-1000XM6", "p3")}
        isBest
        query="sony wh-1000xm6"
        rank={2}
        queryId="qid-1"
        renderStartMs={Date.parse("2026-09-14T00:00:00.000Z")}
      />,
    );
    // With a usable stamp the row CTA names its merchant ("Checked … · Jarir"),
    // so the row button is selectable by the retailer it leads to.
    const row = Array.from(document.body.querySelectorAll<HTMLAnchorElement>("a.btn-primary")).find(
      (a) => a.textContent?.includes("Jarir"),
    );
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLAnchorElement);
    const clicks = sent.filter((e) => e.type === "result_click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ retailer: "Jarir", position: 3, offerId: "p3" });
  });
});
