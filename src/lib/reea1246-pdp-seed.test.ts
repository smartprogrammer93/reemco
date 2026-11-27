/**
 * REEA-1246 (Bet 7) — the clicked card's offer set handoff.
 *
 * Live defect on `0947501b`: `/results?q=iphone+17+pro` promised
 * "Wibi KD 314.90" and the cold PDP painted "Eureka KD 331.90" (5.1% worse,
 * different retailer) because the shelf memo is only written at the run's
 * final stage. These pins hold the codec that carries the card's rows on the
 * link, the strict validation of that user-controlled URL, the merge
 * precedence (this page's own rows always win) and the ONE headline rule
 * (an un-buyable price is a reference, never a best-price claim).
 */
import { describe, expect, it } from "vitest";
import {
  PDP_SEED_MAX_ROWS,
  decodeClickSeed,
  encodeClickSeed,
  mergeSeededOfferRows,
  pdpHeadlineClaim,
  type SeededOffer,
} from "@/lib/pdp-click-seed";
import type { PriceOffer } from "@/types/product";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const STAMP = NOW - 30_000;

function offer(overrides: Partial<PriceOffer> & { collectedAt?: string; collectedAtEpochMs?: number }): PriceOffer {
  return {
    merchant: "Wibi",
    price: 314.9,
    currency: "KWD",
    url: "https://wibi.com.kw/products/apple-iphone-17-pro-256gb",
    inStock: true,
    collectedAt: new Date(STAMP).toISOString(),
    collectedAtEpochMs: STAMP,
    ...overrides,
  } as unknown as PriceOffer;
}

const PRODUCT_ID = "apple-iphone17-pro-256gb";

describe("REEA-1246 — click seed codec", () => {
  it("round-trips the card's rows with their own live stamp and composition", () => {
    const token = encodeClickSeed(PRODUCT_ID, [
      offer({
        merchant: "Wibi",
        price: 314.9,
        wasPrice: 365,
        effectivePrice: 314.9,
        priceComposition: { listed: 365, appliedDiscount: 50.1, effective: 314.9, kind: "was_price" },
      }),
      offer({ merchant: "Xcite", price: 333.9, url: "https://www.xcite.com/p/1" }),
    ]);
    expect(token).toBeTruthy();
    const decoded = decodeClickSeed(token, PRODUCT_ID, NOW);
    expect(decoded).not.toBeNull();
    expect(decoded?.rows).toHaveLength(2);
    const wibi = decoded!.rows.find((r) => r.merchant === "Wibi")!;
    expect(wibi.price).toBe(314.9);
    expect(wibi.currency).toBe("KWD");
    expect(wibi.inStock).toBe(true);
    expect(wibi.collectedAtEpochMs).toBe(STAMP);
    expect(wibi.method).toBe("cache"); // never claims this run's verification
    expect(wibi.priceComposition).toEqual({
      listed: 365,
      appliedDiscount: 50.1,
      effective: 314.9,
      kind: "was_price",
    });
    expect(wibi.effectivePrice).toBe(314.9);
  });

  it("carries the sanity verdict (including the ratio) so the PDP applies the card's own headline gate", () => {
    const token = encodeClickSeed(PRODUCT_ID, [
      offer({ merchant: "Amazon.eg", price: 2.9, sanity: { status: "ok", ratioToMedian: 0.05 } }),
    ])!;
    const decoded = decodeClickSeed(token, PRODUCT_ID, NOW)!;
    expect(decoded.rows[0].sanity).toEqual({ status: "ok", ratioToMedian: 0.05 });
  });

  it("carries one row per retailer before extra prices so a card cannot lose a retailer", () => {
    const token = encodeClickSeed(PRODUCT_ID, [
      offer({ merchant: "Wibi", price: 314.9 }),
      offer({ merchant: "Wibi", price: 350, url: "https://wibi.com.kw/b" }),
      offer({ merchant: "Eureka", price: 331.9, url: "https://eureka.com.kw/a" }),
      offer({ merchant: "Xcite", price: 333.9, url: "https://xcite.com/a" }),
      offer({ merchant: "Blink", price: 350, url: "https://blink.com.kw/a" }),
    ]);
    const decoded = decodeClickSeed(token, PRODUCT_ID, NOW)!;
    // Every retailer is carried first; the extra real Wibi price fills the
    // remaining slot afterwards.
    expect(decoded.rows.map((r) => r.merchant)).toEqual(["Wibi", "Eureka", "Xcite", "Blink", "Wibi"]);
    expect(decoded.rows.length).toBeLessThanOrEqual(PDP_SEED_MAX_ROWS);
  });

  it("rejects a token minted for another product and malformed tokens", () => {
    const token = encodeClickSeed(PRODUCT_ID, [offer({})])!;
    expect(decodeClickSeed(token, "another-product", NOW)).toBeNull();
    expect(decodeClickSeed("not-base64!!", PRODUCT_ID, NOW)).toBeNull();
    expect(decodeClickSeed(undefined, PRODUCT_ID, NOW)).toBeNull();
    expect(decodeClickSeed("", PRODUCT_ID, NOW)).toBeNull();
  });

  it("drops rows the URL got wrong and clamps a future stamp", () => {
    const token = encodeClickSeed(PRODUCT_ID, [
      offer({ merchant: "Wibi", price: 314.9 }),
      offer({ merchant: "Xcite", price: 333.9, url: "https://www.xcite.com/p/1" }),
    ])!;
    // Rebuild the payload by hand to inject hostile rows.
    const payload = JSON.parse(
      Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    payload[2].push(["Bad Currency", 100, "EURO", 1, NOW, "https://bad.example/p", null, null, null, 0, 0, null]);
    payload[2].push(["Negative", -1, "KWD", 1, NOW, "https://neg.example/p", null, null, null, 0, 0, null]);
    payload[2].push(["Javascript", 100, "KWD", 1, NOW, "javascript:alert(1)", null, null, null, 0, 0, null]);
    payload[2].push(["No Stamp", 100, "KWD", 1, 0, "https://nostamp.example/p", null, null, null, 0, 0, null]);
    payload[2].push(["Future", 100, "KWD", 1, NOW + 3_600_000, "https://future.example/p", null, null, null, 0, 0, null]);
    const rebuilt = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const decoded = decodeClickSeed(rebuilt, PRODUCT_ID, NOW)!;
    expect(decoded.rows.map((r) => r.merchant)).toEqual(["Wibi", "Xcite", "Future"]);
    const future = decoded.rows.find((r) => r.merchant === "Future")!;
    expect(future.collectedAtEpochMs).toBe(NOW);
  });
});

describe("REEA-1246 — seed merge precedence", () => {
  it("never lets a seeded row override this page's own fresher row", () => {
    const base = [offer({ merchant: "Wibi", price: 310, url: "https://wibi.com.kw/live" })];
    const seed = [
      offer({ merchant: "Wibi", price: 314.9, url: "https://wibi.com.kw/live" }),
      offer({ merchant: "Eureka", price: 331.9, url: "https://eureka.com.kw/a" }),
    ];
    const merged = mergeSeededOfferRows(base, seed as unknown as PriceOffer[]);
    expect(merged).toHaveLength(2);
    expect(merged[0].price).toBe(310);
    expect(merged[1].merchant).toBe("Eureka");
  });

  it("dedupes the same real offer (merchant + currency + price) even across URLs", () => {
    const base = [offer({ merchant: "Eureka", price: 331.9, url: "https://eureka.com.kw/a" })];
    const seed = [offer({ merchant: "Eureka", price: 331.9, url: "https://eureka.com.kw/b" })];
    expect(mergeSeededOfferRows(base, seed as unknown as PriceOffer[])).toHaveLength(1);
  });
});

describe("REEA-1246 — headline integrity", () => {
  const row = (overrides: Partial<SeededOffer>): SeededOffer =>
    ({
      merchant: "Wibi",
      domain: "wibi.com.kw",
      price: 314.9,
      currency: "KWD",
      url: "https://wibi.com.kw/a",
      inStock: true,
      collectedAt: new Date(STAMP).toISOString(),
      collectedAtEpochMs: STAMP,
      method: "cache",
      ...overrides,
    }) as SeededOffer;

  it("an in-stock offer wins even when a cheaper out-of-stock row exists", () => {
    const claim = pdpHeadlineClaim(
      [row({ merchant: "Xcite", price: 299, inStock: false }), row({ price: 314.9 })],
      "KW",
    );
    expect(claim.kind).toBe("in-stock");
    expect(claim.best?.merchant).toBe("Wibi");
  });

  it("an out-of-stock-only set is a disclosed price reference, never a best claim", () => {
    const claim = pdpHeadlineClaim(
      [row({ merchant: "Xcite", price: 317.21, inStock: false }), row({ merchant: "Eureka", price: 331.9, inStock: false })],
      "KW",
    );
    expect(claim.kind).toBe("out-of-stock-reference");
    expect(claim.best?.price).toBe(317.21);
  });

  it("keeps the disclosed cross-market in-stock fallback when no local offer exists", () => {
    const claim = pdpHeadlineClaim([row({ merchant: "Danube Home", price: 3, currency: "SAR" })], "KW");
    expect(claim.kind).toBe("in-stock");
    expect(claim.best?.merchant).toBe("Danube Home");
  });

  it("is empty when nothing answered", () => {
    expect(pdpHeadlineClaim([], "KW")).toEqual({ best: null, kind: "none" });
  });

  it("does not headline a low-ratio row the card already demoted as a mismatch", () => {
    const claim = pdpHeadlineClaim(
      [
        row({ merchant: "Amazon.eg", price: 2.9, sanity: { status: "ok", ratioToMedian: 0.05 } }),
        row({ price: 314.9 }),
      ],
      "KW",
    );
    expect(claim.kind).toBe("in-stock");
    expect(claim.best?.merchant).toBe("Wibi");
  });
});
