// @vitest-environment jsdom
/**
 * REEA-965 — client-side v1 emission from the results surface (AC-5/AC-7).
 *
 * Integration pins over the committed wiring: the converged-set pass emits
 * `offer_rendered` per rendered card (with the R1 sanity verdict mapped onto
 * priceSanityStatus) plus `coupon_hit` exactly where the card's coupon module
 * has an offer; a related-band click fires `related_click` with the item's
 * cheapest-offer retailer; a primary-card click carries the server render's
 * queryId into `result_click`. All fire-and-forget (AC-9 by construction).
 */
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent } from "@/lib/telemetry";
import type { NormalizedProduct } from "@/types/product";

const sent: ClientEvent[] = [];

const searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

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

import ResultsClient from "@/components/ResultsClient";

afterEach(() => {
  cleanup();
  sent.length = 0;
  vi.clearAllMocks();
});

function product(overrides: Partial<NormalizedProduct> & { productId: string }): NormalizedProduct {
  return {
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: [
      {
        merchant: "Xcite",
        price: 364.9,
        currency: "KWD",
        url: "https://xcite.example/p",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  } as NormalizedProduct;
}

describe("REEA-965 client offer events", () => {
  it("emits offer_rendered per rendered card with R1 sanity, and coupon_hit exactly where coupons exist", async () => {
    searchParams.set("q", "sony wh-1000xm6");
    const products: NormalizedProduct[] = [
      product({
        productId: "p-ok",
        offers: [
          {
            merchant: "Xcite",
            price: 364.9,
            currency: "KWD",
            url: "https://xcite.example/p",
            inStock: true,
            sanity: { status: "ok" },
          },
        ],
        coupons: [{ code: "S10", description: "10% off", discount: "10% off", expiresAt: null }],
      }),
      product({
        productId: "p-flagged",
        offers: [
          {
            merchant: "Jarir",
            price: 0.46,
            currency: "KWD",
            url: "https://jarir.example/p",
            inStock: true,
            sanity: { status: "flagged", reason: "outlier_low" },
          },
        ],
        coupons: [],
      }),
    ];
    await act(async () => {
      render(<ResultsClient query="sony wh-1000xm6" page={1} products={products} queryId="qid-9" />);
    });
    const rendered = sent.filter((e) => e.type === "offer_rendered");
    expect(rendered).toHaveLength(2);
    // Lead merchant attribution + R1 verdict mapping + coupon flag.
    // (offer_rendered carries no offerId per the spec table — the coupon_hit
    // events below carry the offer identity.)
    expect(rendered[0]).toMatchObject({
      queryId: "qid-9",
      retailer: "Xcite",
      hasCoupon: true,
      priceSanityStatus: "ok",
      schema: 1,
    });
    expect(rendered[1]).toMatchObject({
      queryId: "qid-9",
      retailer: "Jarir",
      hasCoupon: false,
      priceSanityStatus: "outlier_low",
    });
    const hits = sent.filter((e) => e.type === "coupon_hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ queryId: "qid-9", retailer: "Xcite", offerId: "p-ok" });
  });

  it("emits no v1 offer events without the queryId context", async () => {
    searchParams.set("q", "sony");
    await act(async () => {
      render(
        <ResultsClient
          query="sony wh-1000xm6"
          page={1}
          products={[product({ productId: "p1" })]}
        />,
      );
    });
    expect(sent.filter((e) => e.type === "offer_rendered")).toHaveLength(0);
    expect(sent.filter((e) => e.type === "coupon_hit")).toHaveLength(0);
    // The REEA-37 funnel events still fire.
    expect(sent.filter((e) => e.type === "result_impressed")).toHaveLength(1);
  });

  it("fires related_click with the band item's cheapest-offer retailer", async () => {
    searchParams.set("q", "sony wh-1000xm6");
    // The accessory-marked title under a device query scores 1 → related band.
    await act(async () => {
      render(
        <ResultsClient
          query="sony wh-1000xm6"
          page={1}
          products={[
            product({
              productId: "case-1",
              title: "Sony WH-1000XM6 Case",
              offers: [
                {
                  merchant: "Eureka",
                  price: 8,
                  currency: "KWD",
                  url: "https://eureka.example/c",
                  inStock: true,
                },
              ],
            }),
          ]}
          queryId="qid-9"
        />,
      );
    });
    const band = document.querySelector('[data-related-band="true"]');
    expect(band).not.toBeNull();
    const link = band!.querySelector<HTMLAnchorElement>("a.related-item-link");
    expect(link).not.toBeNull();
    await act(async () => {
      fireEvent.click(link as HTMLAnchorElement);
    });
    const related = sent.filter((e) => e.type === "related_click");
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({
      queryId: "qid-9",
      offerId: "case-1",
      retailer: "Eureka",
      schema: 1,
    });
  });

  it("a primary-card click in the rendered grid carries the queryId into result_click", async () => {
    searchParams.set("q", "sony wh-1000xm6");
    await act(async () => {
      render(
        <ResultsClient
          query="sony wh-1000xm6"
          page={1}
          products={[product({ productId: "p-first" }), product({ productId: "p-second", title: "Sony WH-1000XM6 Silver" })]}
          queryId="qid-9"
        />,
      );
    });
    const cta = document.body.querySelector<HTMLAnchorElement>("a.cta-lead");
    expect(cta).not.toBeNull();
    await act(async () => {
      fireEvent.click(cta as HTMLAnchorElement);
    });
    const clicks = sent.filter((e) => e.type === "result_click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({
      queryId: "qid-9",
      offerId: "p-first",
      position: 1,
      retailer: "Xcite",
    });
    expect(sent.filter((e) => e.type === "first_result_click")).toHaveLength(1);
  });
});
