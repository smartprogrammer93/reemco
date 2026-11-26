/**
 * REEA-1178 — Bet 6c identity/duplicate integrity.
 *
 * Every assertion here is pinned to the live evidence in the ticket:
 *  - `/results?q=iphone%2017%20pro` served 10 products for 8 productIds
 *    (`fb1747d2`) because a "+ Wireless Charger" bundle is accessory-classed
 *    yet shares the base phone's canonical tuple;
 *  - the Anker AeroFit 2 card's slug was derived from an Amazon.eg accessory
 *    title ("… P47M Cat LED Over Stereo Music Card …") and drifted between
 *    collections;
 *  - that accessory offer (ratioToMedian 0.09997, sanity `ok` under the
 *    collector's 15× cohort bound) counted as a comparison retailer;
 *  - two Eureka 1TB listings at KD 489.90 rendered with only one label, so the
 *    regional versions were indistinguishable;
 *  - `comparison_depth.cards_multi_retailer` folded all of the above.
 *
 * The tests exercise the ONE definitions (lib/offer-integrity.ts,
 * lib/results-shelf.ts, lib/collect/canonical-product.ts) so a regression in
 * any consumer fails here instead of on the live shelf.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

process.env.METRICS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-metrics-1178-"));
process.env.EVENTS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-events-1178-"));
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const {
  canonicalFields,
  identityClassToken,
  productSlugFor,
  uniqueGroupSlugs,
} = await import("@/lib/collect/canonical-product");
const {
  comparisonMerchantsOf,
  dedupeOfferRows,
  distinguishSamePriceRows,
  isPossibleMismatchOffer,
} = await import("@/lib/offer-integrity");
const { shelfSectionsFromProducts, uniqueCardsByProductId } = await import("@/lib/results-shelf");
const { comparisonDepthOf, emptyWeek } = await import("@/lib/metrics");
const { weeklyResponse } = await import("@/app/api/metrics/weekly/route");

function offer(overrides: Partial<PriceOffer>): PriceOffer {
  return {
    merchant: "Xcite",
    price: 100,
    currency: "KWD",
    url: "https://xcite.example/listing",
    inStock: true,
    ...overrides,
  };
}

describe("AC1 — one card per productId, bundles get their own identity", () => {
  it("a bundle group sharing the device tuple is disambiguated from its own URL evidence", () => {
    const deviceSlug = productSlugFor(canonicalFields("Apple iPhone 17 Pro 256Gb Silver"));
    const bundleSlug = productSlugFor(
      canonicalFields("Apple iPhone 17 Pro 5G 256 GB, Silver + Wireless Charger"),
    );
    // Root cause: the bundle's canonical tuple IS the base phone's, so the
    // slug collides before the collision pass runs.
    expect(bundleSlug).toBe(deviceSlug);

    const slugs = uniqueGroupSlugs([
      {
        slug: deviceSlug,
        accessory: false,
        titles: ["Apple iPhone 17 Pro 256Gb Silver"],
        urls: ["https://www.xcite.com/apple-iphone-17-pro-6-3-256gb-silver/p"],
      },
      {
        slug: bundleSlug,
        accessory: true,
        titles: ["Apple iPhone 17 Pro 5G 256 GB, Silver + Wireless Charger"],
        urls: [
          "https://wibi.com.kw/products/bundle-offer-apple-iphone-17-pro-256gb-cosmic-orange-5g-6-3-middle-east-version",
        ],
      },
    ]);
    expect(slugs[0]).toBe(deviceSlug); // the device keeps the plain slug
    expect(slugs[1]).toBe(`${deviceSlug}-bundle`);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(identityClassToken([], ["https://wibi.com.kw/products/bundle-offer-x"])).toBe("bundle");
  });

  it("two same-class groups never share an id (stable ordinal, device first)", () => {
    const slugs = uniqueGroupSlugs([
      { slug: "anker-case", accessory: true, titles: ["Anker Case A"], urls: [] },
      { slug: "anker-case", accessory: true, titles: ["Anker Case B"], urls: [] },
      { slug: "anker-case", accessory: false, titles: ["Anker Device"], urls: [] },
    ]);
    expect(slugs[2]).toBe("anker-case");
    expect(new Set(slugs).size).toBe(3);
    // Deterministic: the same input set produces the same ids every run.
    expect(
      uniqueGroupSlugs([
        { slug: "anker-case", accessory: false, titles: ["Anker Device"], urls: [] },
        { slug: "anker-case", accessory: true, titles: ["Anker Case B"], urls: [] },
        { slug: "anker-case", accessory: true, titles: ["Anker Case A"], urls: [] },
      ]),
    ).toEqual([slugs[2], slugs[1], slugs[0]]);
  });

  it("the shelf chain paints a twin productId once, first-ranked wins", () => {
    const a = {
      productId: "apple-iphone17-pro-256gb",
      title: "Apple iPhone 17 Pro 256Gb Silver",
      offers: [offer({ price: 314.9, url: "https://wibi.example/a" })],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: "2026-11-26T00:00:00.000Z",
    } as unknown as NormalizedProduct;
    const twin = {
      ...a,
      title: "Apple iPhone 17 Pro 5G 256 GB, Silver + Wireless Charger",
      offers: [offer({ merchant: "Wibi", price: 354.9, url: "https://wibi.example/bundle" })],
    } as unknown as NormalizedProduct;
    expect(uniqueCardsByProductId([a, twin])).toHaveLength(1);
    expect(uniqueCardsByProductId([a, twin])[0]).toBe(a);
    const sections = shelfSectionsFromProducts([a, twin], "iphone 17 pro", null, false);
    const ids = sections.primary.map((p) => p.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("AC1/false merge — identity no longer drifts with an accessory title", () => {
  it("a brand-last title yields its own model line instead of borrowing a neighbour's", () => {
    const earbuds = canonicalFields("Soundcore AeroFit 2 Open-Ear Wireless Earbuds -  Anker");
    const accessory = canonicalFields(
      "Anker Soundcore AeroFit 2 Open-Ear Wireless Earbuds - P47M Cat LED Over Stereo Music Card Support Kids Girls PC",
    );
    // The device title names its line even though the brand token is last.
    expect(earbuds.modelLine).not.toBe("");
    // The accessory title's long tail must not become the card's slug head:
    // the device's own (shorter) line wins the merge identity.
    expect(earbuds.modelLine.length).toBeLessThan(accessory.modelLine.length);
    expect(productSlugFor(earbuds)).toBe("anker-soundcore-aerofit2-open");
    expect(productSlugFor(accessory)).toContain("p47m");
  });
});

describe("AC2/AC3 — offer rows and the retailer count", () => {
  it("dedupes same merchant+price+URL and never counts a mismatch offer", () => {
    const rows: PriceOffer[] = [
      offer({ merchant: "Amazon.eg", price: 245, currency: "EGP", url: "https://www.amazon.eg/dp/B0FQFL2G9X", sanity: { status: "ok", ratioToMedian: 0.09996655518394651 } }),
      offer({ merchant: "Switch", price: 22.99, currency: "KWD", url: "https://switch.example/aerofit", sanity: { status: "ok", ratioToMedian: 1.53 } }),
      // Same purchasable unit fetched twice must count once.
      offer({ merchant: "Switch", price: 22.99, currency: "KWD", url: "https://switch.example/aerofit/", sanity: { status: "ok", ratioToMedian: 1.53 } }),
    ];
    expect(isPossibleMismatchOffer(rows[0])).toBe(true); // ratio < 0.1 even though sanity says ok
    expect(isPossibleMismatchOffer(rows[1])).toBe(false);
    expect(comparisonMerchantsOf(rows, "KW")).toEqual(["switch"]);
    expect(dedupeOfferRows(rows)).toHaveLength(2);
  });

  it("a LOW outlier / price-integrity flag is a mismatch; a high outlier is still a lane", () => {
    expect(isPossibleMismatchOffer(offer({ sanity: { status: "flagged", reason: "outlier_low", ratioToMedian: 0.053 } }))).toBe(true);
    expect(isPossibleMismatchOffer(offer({ sanity: { status: "flagged", reason: "currency_mis_map" } }))).toBe(true);
    expect(isPossibleMismatchOffer(offer({ sanity: { status: "flagged", reason: "price_unavailable" } }))).toBe(true);
    expect(isPossibleMismatchOffer(offer({}))).toBe(false);
    expect(isPossibleMismatchOffer(offer({ sanity: { status: "ok", ratioToMedian: 1.2 } }))).toBe(false);
    // Live `fold 7`: every phone was outlier_high because the cohort median
    // was set by KD 4.9 cases. Those are the same product — they must count,
    // or a card with four real stores would report zero retailers.
    expect(isPossibleMismatchOffer(offer({ sanity: { status: "flagged", reason: "outlier_high", ratioToMedian: 64.7 } }))).toBe(false);
  });

  it("keeps the retailer count on a card whose offers are all high outliers (fold 7)", () => {
    const rows = [
      offer({ merchant: "Xcite", price: 379.9, url: "https://xcite.example/fold7", sanity: { status: "flagged", reason: "outlier_high", ratioToMedian: 64.7 } }),
      offer({ merchant: "Blink", price: 385, url: "https://blink.example/fold7", sanity: { status: "flagged", reason: "outlier_high", ratioToMedian: 65.6 } }),
      offer({ merchant: "Eureka", price: 494.9, url: "https://eureka.example/fold7", sanity: { status: "flagged", reason: "outlier_high", ratioToMedian: 84.3 } }),
    ];
    expect(comparisonMerchantsOf(rows, "KW")).toHaveLength(3);
  });

  it("counts only the card's own market", () => {
    const rows = [
      offer({ merchant: "Xcite", currency: "KWD", sanity: { status: "ok", ratioToMedian: 1 } }),
      offer({ merchant: "Jarir", currency: "SAR", sanity: { status: "ok", ratioToMedian: 1 } }),
    ];
    expect(comparisonMerchantsOf(rows, "KW")).toEqual(["xcite"]);
    expect(comparisonMerchantsOf(rows, "SA")).toEqual(["jarir"]);
  });
});

describe("AC4 — same-price rows are distinguishable", () => {
  it("fills the unlabelled twin with its own listing reference", () => {
    const rows = [
      offer({ merchant: "Eureka", price: 489.9, url: "https://www.eureka.com.kw/products/details/276369", label: "Japanese VR" }),
      offer({ merchant: "Eureka", price: 489.9, url: "https://www.eureka.com.kw/products/details/267450" }),
    ];
    const labelled = distinguishSamePriceRows(rows);
    expect(labelled[0].label).toBe("Japanese VR");
    expect(labelled[1].label).toBe("#267450");
    expect(labelled[0].label).not.toBe(labelled[1].label);
  });

  it("leaves a lone row per merchant, and rows at different prices, untouched", () => {
    const single = [offer({ merchant: "Eureka", price: 489.9, url: "https://www.eureka.com.kw/products/details/267450" })];
    expect(distinguishSamePriceRows(single)).toEqual(single);
    const differentPrice = [
      offer({ merchant: "Eureka", price: 489.9, url: "https://www.eureka.com.kw/products/details/276369", label: "Japanese VR" }),
      offer({ merchant: "Eureka", price: 519.9, url: "https://www.eureka.com.kw/products/details/267450" }),
    ];
    expect(distinguishSamePriceRows(differentPrice)).toEqual(differentPrice);
  });
});

describe("AC3/AC5 — comparison depth excludes artefacts and states its definition", () => {
  it("does not count a mismatch offer as a second retailer", () => {
    const card = {
      productId: "anker-aerofit2",
      offers: [
        offer({ merchant: "Switch", currency: "KWD", price: 22.99, url: "https://switch.example/a", sanity: { status: "ok", ratioToMedian: 1.53 } }),
        offer({ merchant: "Amazon.eg", currency: "EGP", price: 245, url: "https://www.amazon.eg/dp/B0FQFL2G9X", sanity: { status: "ok", ratioToMedian: 0.09996655518394651 } }),
      ],
    };
    expect(comparisonDepthOf([card], "KW")).toEqual({
      cardsTotal: 1,
      cardsMultiRetailer: 0,
      cardsCrossMarket: 0,
    });
    // Two clean in-market lanes still count.
    const real = {
      productId: "iphone",
      offers: [
        offer({ merchant: "Xcite", currency: "KWD", url: "https://xcite.example/a", sanity: { status: "ok", ratioToMedian: 1 } }),
        offer({ merchant: "Wibi", currency: "KWD", url: "https://wibi.example/a", sanity: { status: "ok", ratioToMedian: 1.01 } }),
        offer({ merchant: "Eureka", currency: "KWD", url: "https://eureka.example/a", sanity: { status: "flagged", reason: "outlier_low", ratioToMedian: 0.05 } }),
      ],
    };
    expect(comparisonDepthOf([real], "KW")).toEqual({
      cardsTotal: 1,
      cardsMultiRetailer: 1,
      cardsCrossMarket: 0,
    });
  });

  it("the weekly payload carries the definition and the pre-change reference", async () => {
    const week = "2026-W48";
    const counters = emptyWeek();
    counters.comparison_cards_total = 40;
    counters.comparison_cards_multi_retailer = 12;
    const res = weeklyResponse({ weeks: { [week]: counters }, source: "local", kvReadFailed: false }, {}, 8);
    const body = (await res.json()) as {
      weeks: Record<string, { comparison_depth: Record<string, unknown> }>;
    };
    const depth = body.weeks[week].comparison_depth;
    expect(String(depth.definition)).toContain("distinct in-market merchants with a non-flagged offer");
    expect(depth.pre_change_reference).toEqual(expect.objectContaining({ ratio: 0.1713 }));
    // The post-change number is reported on the same payload.
    expect(depth.ratio).toBeCloseTo(12 / 40);
  });
});
