/**
 * REEA-540 Bet A — deterministic coverage of the confidence-line roll-up:
 * window filter, merchant-day dedup (latest wins), the ≥3-days threshold that
 * hides the line, merchant/country scoping, KWD-space comparison, and the
 * formatter-backed range label. Render coverage (EN + AR) lives beside the
 * card in ProductResultCard.test.tsx. Every case pins its own clock so the
 * window math never depends on the wall clock of the runner.
 */
import { describe, expect, it } from "vitest";
import {
  attachSeenRanges,
  formatSeenRangeLabel,
  MAX_SEEN_SPREAD,
  merchantDayWinners,
  MIN_SEEN_DAYS,
  seenRangeForCard,
  type SeenRow,
} from "@/lib/seen-range";
import { listingIdentity, type ListingIdentity } from "@/lib/collect/canonical-product";
import type { NormalizedProduct } from "@/types/product";

/** Fixed clock: 2026-09-10T12:00Z. */
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

function row(merchant: string, day: string, price: number, opts: Partial<SeenRow> = {}): SeenRow {
  return { merchant, day, observedAt: `${day}T09:00:00.000Z`, price, currency: "KWD", country: "KW", ...opts };
}

describe("REEA-540 AC2 — rolling-window filter", () => {
  it("keeps days inside the window and drops days past it", () => {
    const inside = row("Xcite", "2026-08-28", 100); // exactly 13 d ago
    const edge = row("Xcite", "2026-08-26", 200); // ~15 d ago → outside
    const kept = merchantDayWinners([inside, edge], NOW);
    expect(kept.map((r) => r.price)).toEqual([100]);
  });

  it("a far-old outlier never drags the range", () => {
    const rows = [
      row("Xcite", "2026-09-08", 4100),
      row("Jarir", "2026-09-09", 4200),
      row("Eureka", "2026-09-10", 4300),
      // Nine days before the window opens: a cheap ancient stamp must not
      // join the min — the line states what the window actually saw.
      row("Xcite", "2026-08-01", 999),
    ];
    const range = seenRangeForCard(rows, new Set(["Xcite", "Jarir", "Eureka"]), { nowMs: NOW });
    expect(range).toEqual({
      min: { price: 4100, currency: "KWD" },
      max: { price: 4300, currency: "KWD" },
    });
  });
});

describe("REEA-540 AC3 — merchant-day dedup, latest wins", () => {
  it("same merchant same day keeps only the latest observation", () => {
    const rows = [
      row("Xcite", "2026-09-08", 120, { observedAt: "2026-09-08T08:00:00.000Z" }),
      row("Xcite", "2026-09-08", 100, { observedAt: "2026-09-08T16:00:00.000Z" }),
      row("Jarir", "2026-09-09", 130),
      row("Eureka", "2026-09-10", 140),
    ];
    const kept = merchantDayWinners(rows, NOW);
    // Xcite/2026-09-08 collapses to the 16:00 write (price 100); the 08:00
    // write drops out entirely rather than averaging in.
    expect(kept.find((r) => r.merchant === "Xcite")?.price).toBe(100);
    expect(kept.filter((r) => r.merchant === "Xcite")).toHaveLength(1);
    // Same stamp, different offers = one observation: both rows survive.
    const tie = merchantDayWinners(
      [row("Xcite", "2026-09-08", 10), row("Xcite", "2026-09-08", 20)],
      NOW,
    );
    expect(tie.map((r) => r.price).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it("different merchants on the same day are separate merchant-days", () => {
    const kept = merchantDayWinners(
      [row("Xcite", "2026-09-09", 100), row("Jarir", "2026-09-09", 110)],
      NOW,
    );
    expect(kept).toHaveLength(2);
  });
});

describe("REEA-540 AC2 — insufficient data hides the line", () => {
  it("two distinct days return null — never interpolated up to three", () => {
    const rows = [row("Xcite", "2026-09-09", 100), row("Jarir", "2026-09-10", 110)];
    expect(MIN_SEEN_DAYS).toBe(3);
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir"]), { nowMs: NOW })).toBeNull();
  });

  it("three distinct days unlock the range", () => {
    const rows = [
      row("Xcite", "2026-09-08", 100),
      row("Jarir", "2026-09-09", 110),
      row("Eureka", "2026-09-10", 120),
    ];
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir", "Eureka"]), { nowMs: NOW })).toEqual({
      min: { price: 100, currency: "KWD" },
      max: { price: 120, currency: "KWD" },
    });
  });
});

describe("REEA-540 — card scoping and one comparison scale", () => {
  it("observations from merchants outside the card never count", () => {
    const rows = [
      row("Xcite", "2026-09-08", 100),
      row("Jarir", "2026-09-09", 110),
      row("Eureka", "2026-09-10", 900),
    ];
    // The card is served by Xcite + Jarir only: Eureka's 900 stays out of
    // BOTH the max and the day count → only 2 card-days → hidden line.
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir"]), { nowMs: NOW })).toBeNull();
  });

  it("a country selection drops other countries' rows", () => {
    const rows = [
      row("Xcite", "2026-09-08", 100),
      row("Jarir", "2026-09-09", 110),
      row("Najma", "2026-09-10", 120, { country: "SA" }),
    ];
    // KW selection: the SA row is outside the view → two KW days → hidden.
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir", "Najma"]), { country: "KW", nowMs: NOW })).toBeNull();
    // No selection: every row counts → three days.
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir", "Najma"]), { nowMs: NOW })).not.toBeNull();
  });

  it("min/max compare in KWD-space, native figures render unchanged", () => {
    const rows = [
      row("Xcite", "2026-09-08", 100), // KWD 100 → 100 in KWD-space
      row("Jarir", "2026-09-09", 500, { currency: "SAR" }), // ≈40.8 KD
      row("Eureka", "2026-09-10", 120),
    ];
    // Raw numerics would say 100 < 120 < 500; the shared conversion says the
    // SAR listing is the CHEAPEST and the KWD 120 the priciest. Endpoints
    // keep their native figures (display path is the formatter's job). The
    // 120/40.8 = 2.94 spread stays inside the REEA-1167 sanity cap, so this
    // case still pins the KWD-space comparison itself.
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir", "Eureka"]), { nowMs: NOW })).toEqual({
      min: { price: 500, currency: "SAR" },
      max: { price: 120, currency: "KWD" },
    });
  });
});

describe("REEA-540 AC1 — attachSeenRanges is additive", () => {
  const card = (merchants: string[]): NormalizedProduct => ({
    productId: "p1",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: merchants.map((m) => ({ merchant: m, price: 100, currency: "KWD", url: `https://${m}.example/p`, inStock: true })),
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-10T09:00:00.000Z",
  });

  it("sets seenRange from stored rows on the server-built snapshot", () => {
    const products = [card(["Xcite", "Jarir", "Eureka"])];
    attachSeenRanges(
      products,
      [row("Xcite", "2026-09-08", 100), row("Jarir", "2026-09-09", 110), row("Eureka", "2026-09-10", 120)],
      { nowMs: NOW },
    );
    expect(products[0].seenRange).toEqual({
      min: { price: 100, currency: "KWD" },
      max: { price: 120, currency: "KWD" },
    });
  });

  it("empty observations leave cards exactly as they are — nothing rendered", () => {
    const products = [card(["Xcite"])];
    attachSeenRanges(products, [], { nowMs: NOW });
    expect(products[0].seenRange).toBeUndefined();
  });
});

describe("REEA-540 AC4 — label through the existing formatter", () => {
  it("renders both endpoints like every other card figure", () => {
    expect(
      formatSeenRangeLabel(
        { min: { price: 4099, currency: "KWD" }, max: { price: 4350, currency: "KWD" } },
        null,
      ),
    ).toBe("KD 4,099\u2013KD 4,350");
  });

  it("a one-value window collapses to the single figure", () => {
    expect(
      formatSeenRangeLabel(
        { min: { price: 4099, currency: "KWD" }, max: { price: 4099, currency: "KWD" } },
        null,
      ),
    ).toBe("KD 4,099");
  });
});

describe("REEA-1167 — product and market scoping of the confidence fold", () => {
  const DEVICE_TITLE = "Apple iPhone 17 Pro 256Gb Silver";
  const ACCESSORY_TITLE = "Apple iPhone 17 Pro Clear Case with MagSafe MGFT4ZM/A";
  const device = listingIdentity(DEVICE_TITLE);
  const accessory = listingIdentity(ACCESSORY_TITLE);
  const merchants = new Set(["Xcite", "Jarir", "Eureka", "Amazon.eg"]);

  const idRow = (
    merchant: string,
    day: string,
    price: number,
    identity: ListingIdentity,
    opts: Partial<SeenRow> = {},
  ): SeenRow => row(merchant, day, price, { identity, ...opts });

  it("an accessory observation never widens the device card's range", () => {
    const rows = [
      idRow("Xcite", "2026-09-08", 339, device),
      idRow("Jarir", "2026-09-09", 349, device),
      idRow("Eureka", "2026-09-10", 359, device),
      // Same merchant-day as the device row (the round's rows share a stamp):
      // the case's KD 3.50 must not enter the phone card's min.
      idRow("Xcite", "2026-09-08", 3.5, accessory),
    ];
    expect(
      seenRangeForCard(rows, merchants, { nowMs: NOW, identity: device, market: "KW" }),
    ).toEqual({
      min: { price: 339, currency: "KWD" },
      max: { price: 359, currency: "KWD" },
    });
  });

  it("a cross-market observation never joins a KWD card's range", () => {
    const rows = [
      idRow("Xcite", "2026-09-08", 339, device),
      idRow("Jarir", "2026-09-09", 349, device),
      idRow("Eureka", "2026-09-10", 359, device),
      // Amazon.eg answered the same query in EGP; the Kuwait card must not
      // render it, and both endpoints stay in the card's market currency.
      idRow("Amazon.eg", "2026-09-10", 195999, device, { currency: "EGP", country: "EG" }),
    ];
    const range = seenRangeForCard(rows, merchants, { nowMs: NOW, identity: device, market: "KW" });
    expect(range).toEqual({
      min: { price: 339, currency: "KWD" },
      max: { price: 359, currency: "KWD" },
    });
    expect(range?.min.currency).toBe("KWD");
    expect(range?.max.currency).toBe("KWD");
  });

  it("a scoped spread wider than 3× renders nothing", () => {
    const rows = [
      idRow("Xcite", "2026-09-08", 100, device),
      idRow("Jarir", "2026-09-09", 200, device),
      idRow("Eureka", "2026-09-10", 500, device),
    ];
    expect(MAX_SEEN_SPREAD).toBe(3);
    expect(
      seenRangeForCard(rows, merchants, { nowMs: NOW, identity: device, market: "KW" }),
    ).toBeNull();
    // Exactly 3× is legal — the cap is a "> 3" rejection, not ">= 3".
    const atCap = [
      idRow("Xcite", "2026-09-08", 100, device),
      idRow("Jarir", "2026-09-09", 200, device),
      idRow("Eureka", "2026-09-10", 300, device),
    ];
    expect(
      seenRangeForCard(atCap, merchants, { nowMs: NOW, identity: device, market: "KW" }),
    ).not.toBeNull();
  });

  it("a single scoped observation renders first-seen, not nothing", () => {
    const rows = [idRow("Eureka", "2026-09-10", 94.95, device)];
    expect(
      seenRangeForCard(rows, merchants, { nowMs: NOW, identity: device, market: "KW" }),
    ).toEqual({
      min: { price: 94.95, currency: "KWD" },
      max: { price: 94.95, currency: "KWD" },
      firstSeen: true,
    });
  });

  it("an unresolvable market renders nothing rather than a mixed range", () => {
    const rows = [
      idRow("Xcite", "2026-09-08", 339, device),
      idRow("Jarir", "2026-09-09", 349, device),
      idRow("Eureka", "2026-09-10", 359, device),
    ];
    expect(
      seenRangeForCard(rows, merchants, { nowMs: NOW, identity: device, market: null }),
    ).toBeNull();
  });
});

describe("REEA-1167 — attachSeenRanges scopes the served card", () => {
  const deviceCard = (offers: { merchant: string; price: number; currency: string }[]): NormalizedProduct => ({
    productId: "apple-iphone17-pro-256gb",
    title: "Apple iPhone 17 Pro 256Gb Silver",
    brand: "Apple",
    offers: offers.map((o) => ({ ...o, url: `https://${o.merchant}.example/p`, inStock: true })),
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-10T09:00:00.000Z",
  });
  const device = listingIdentity("Apple iPhone 17 Pro 256Gb Silver");
  const accessory = listingIdentity("Apple iPhone 17 Pro Clear Case with MagSafe MGFT4ZM/A");
  const idRow = (
    merchant: string,
    day: string,
    price: number,
    identity: ListingIdentity,
    opts: Partial<SeenRow> = {},
  ): SeenRow => row(merchant, day, price, { identity, ...opts });

  it("a Kuwait card renders no EGP figure even when the merchant answered in EGP", () => {
    const products = [
      deviceCard([
        { merchant: "Xcite", price: 339, currency: "KWD" },
        { merchant: "Jarir", price: 349, currency: "KWD" },
        { merchant: "Eureka", price: 359, currency: "KWD" },
        { merchant: "Amazon.eg", price: 195999, currency: "EGP" },
      ]),
    ];
    attachSeenRanges(
      products,
      [
        idRow("Xcite", "2026-09-08", 339, device),
        idRow("Jarir", "2026-09-09", 349, device),
        idRow("Eureka", "2026-09-10", 359, device),
        idRow("Amazon.eg", "2026-09-10", 195999, device, { currency: "EGP", country: "EG" }),
      ],
      { nowMs: NOW },
    );
    expect(products[0].seenRange).toEqual({
      min: { price: 339, currency: "KWD" },
      max: { price: 359, currency: "KWD" },
    });
  });

  it("a device card excludes its accessory's observation", () => {
    const products = [
      deviceCard([
        { merchant: "Xcite", price: 339, currency: "KWD" },
        { merchant: "Jarir", price: 349, currency: "KWD" },
        { merchant: "Eureka", price: 359, currency: "KWD" },
      ]),
    ];
    attachSeenRanges(
      products,
      [
        idRow("Xcite", "2026-09-08", 339, device),
        idRow("Jarir", "2026-09-09", 349, device),
        idRow("Eureka", "2026-09-10", 359, device),
        idRow("Xcite", "2026-09-08", 3.5, accessory),
      ],
      { nowMs: NOW },
    );
    expect(products[0].seenRange).toEqual({
      min: { price: 339, currency: "KWD" },
      max: { price: 359, currency: "KWD" },
    });
  });

  it("a cross-market-only card renders its own market's currency", () => {
    const products = [deviceCard([{ merchant: "Amazon.eg", price: 195999, currency: "EGP" }])];
    attachSeenRanges(
      products,
      [
        idRow("Amazon.eg", "2026-09-08", 180000, device, { currency: "EGP", country: "EG" }),
        idRow("Amazon.eg", "2026-09-09", 190000, device, { currency: "EGP", country: "EG" }),
        idRow("Amazon.eg", "2026-09-10", 195999, device, { currency: "EGP", country: "EG" }),
      ],
      { nowMs: NOW },
    );
    expect(products[0].seenRange).toEqual({
      min: { price: 180000, currency: "EGP" },
      max: { price: 195999, currency: "EGP" },
    });
  });

  it("a card with no resolvable market currency renders nothing", () => {
    const products = [deviceCard([{ merchant: "Xcite", price: 339, currency: "XYZ" }])];
    attachSeenRanges(
      products,
      [
        idRow("Xcite", "2026-09-08", 339, device, { currency: "XYZ" }),
        idRow("Xcite", "2026-09-09", 339, device, { currency: "XYZ" }),
        idRow("Xcite", "2026-09-10", 339, device, { currency: "XYZ" }),
      ],
      { nowMs: NOW },
    );
    expect(products[0].seenRange).toBeUndefined();
  });

  it("pre-identity phone rows do not land on a case card (plausibility band)", () => {
    const caseCard: NormalizedProduct = {
      productId: "apple-silicone-case-magsafe-iphone17-pro",
      title: "Apple Silicone Case MagSafe For iPhone 17 Pro",
      brand: "Apple",
      offers: [
        { merchant: "Eureka", price: 15, currency: "KWD", url: "https://eureka.example/case", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: "2026-09-10T09:00:00.000Z",
    };
    // Eureka's stored answer for the query mixes the phone (KD 429.90/539.90)
    // and the case (KD 15). Those rows predate the identity tag; the band
    // derived from the case card's own KD 15 offer keeps only the case rows.
    attachSeenRanges(
      [
        caseCard,
      ],
      [
        row("Eureka", "2026-09-08", 429.9),
        row("Eureka", "2026-09-08", 15),
        row("Eureka", "2026-09-09", 539.9),
        row("Eureka", "2026-09-09", 15.5),
        row("Eureka", "2026-09-10", 429.9),
        row("Eureka", "2026-09-10", 14.9),
      ],
      { nowMs: NOW },
    );
    expect(caseCard.seenRange).toEqual({
      min: { price: 14.9, currency: "KWD" },
      max: { price: 15.5, currency: "KWD" },
    });
  });
});
