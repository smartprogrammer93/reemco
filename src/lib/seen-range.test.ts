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
  merchantDayWinners,
  MIN_SEEN_DAYS,
  seenRangeForCard,
  type SeenRow,
} from "@/lib/seen-range";
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
      row("Eureka", "2026-09-10", 150),
    ];
    // Raw numerics would say 100 < 150 < 500; the shared conversion says the
    // SAR listing is the CHEAPEST and the KWD 150 the priciest. Endpoints
    // keep their native figures (display path is the formatter's job).
    expect(seenRangeForCard(rows, new Set(["Xcite", "Jarir", "Eureka"]), { nowMs: NOW })).toEqual({
      min: { price: 500, currency: "SAR" },
      max: { price: 150, currency: "KWD" },
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
