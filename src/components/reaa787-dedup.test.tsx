/**
 * REEA-787 — variant-aware dedup, locked spec (PM brief 93bb70f8 on REEA-758,
 * design confirmation 8f96c322: subtractive only, geometry reused verbatim).
 *
 * Checks:
 *  1. Retailer rows: same merchant + same folded tier + same EFFECTIVE figure
 *     collapses to one row, keep-first on the sorted order (the Danube case:
 *     three equal SAR 5199 (256GB) spellings → one row).
 *  2. Genuine variant tiers stay separate (storage tier, grade, bundle,
 *     LABEL_QUALIFIERS like "Japanese Version"/"eSIM").
 *  3. Same LISTED price with DIFFERENT effective numbers stays separate
 *     (post-REEA-757 rule: the key reads the effective figure).
 *  4. Alternatives: duplicates of one matched product with the identical
 *     formatted figure collapse to one card; different prices never merge.
 *  5. The fold is idempotent and order-preserving (keep-first survivors).
 * Plus the merged REEA-778 reserve pins (heading-slot / coverage-line
 * geometry) ride in results-loading.test.ts and ResultsClient.test.tsx.
 */
import ProductResultCard, { foldAlternativeRows, foldRetailerRows } from "@/components/ProductResultCard";
import { dedupVariantKey } from "@/lib/collect/canonical-product";
import type { NormalizedProduct, PriceOffer, ProductAlternative } from "@/types/product";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

function offer(o: Partial<PriceOffer> & Pick<PriceOffer, "merchant" | "price">): PriceOffer {
  return { currency: "SAR", url: `https://${o.merchant}.example/p`, inStock: true, ...o } as PriceOffer;
}

const danube: PriceOffer[] = [
  offer({ merchant: "Danube Home", price: 5199, label: "256 GB", url: "https://danube.example/a" }),
  offer({ merchant: "Danube Home", price: 5199, label: "256GB", url: "https://danube.example/b" }),
  offer({ merchant: "Danube Home", price: 5199, label: "256 GB - Black", url: "https://danube.example/c" }),
  offer({ merchant: "Danube Home", price: 5699, label: "Max 512GB", url: "https://danube.example/d" }),
  offer({ merchant: "Danube Home", price: 6199, url: "https://danube.example/e" }),
  offer({ merchant: "Danube Home", price: 7199, url: "https://danube.example/f" }),
];

const alts: ProductAlternative[] = [
  { productId: "a", title: "Apple iPhone 17 Pro - eSIM", fromPrice: 80 },
  { productId: "b", title: "Apple iPhone 17 Pro - Japanese Version (eSIM)", fromPrice: 80 },
  { productId: "c", title: "Apple iPhone 17 Pro Max - eSIM", fromPrice: 95 },
];

describe("dedupVariantKey — listingLabel's vocabulary, folded", () => {
  it("folds casing, punctuation and colour/shelf/RAM/marketing restatements", () => {
    expect(dedupVariantKey("256 GB")).toBe(dedupVariantKey("256GB"));
    expect(dedupVariantKey("256 GB")).toBe(dedupVariantKey("256 GB - Black"));
    expect(dedupVariantKey("256 gb")).toBe("256gb");
    expect(dedupVariantKey("XA14 256GB")).toBe("256gb"); // shelf code rides off
    expect(dedupVariantKey("256GB with Face ID | Tax Paid")).toBe("256gb"); // marketing tail rides off
    expect(dedupVariantKey("256GB 12GB RAM")).toBe("256gb"); // RAM restatement rides off
  });

  it("keeps genuine tier information apart: storage, qualifiers, bundles, plain tier words", () => {
    expect(dedupVariantKey("256GB")).not.toBe(dedupVariantKey("512GB"));
    expect(dedupVariantKey("Japanese Version (eSIM)")).not.toBe(dedupVariantKey(""));
    expect(dedupVariantKey("eSIM Bundle")).not.toBe(dedupVariantKey("eSIM"));
    expect(dedupVariantKey("Max")).toBe("max"); // a plain tier word is information
  });

  it("reads Arabic listings through the same fold (sizes join, qualifiers survive)", () => {
    expect(dedupVariantKey("256 جيجابايت")).toBe("256gb");
    expect(dedupVariantKey("نسخة 256 جيجابايت")).toBe("نسخة 256gb");
  });
});

describe("foldRetailerRows — one row per merchant+tier+effective twin", () => {
  it("collapses three equal SAR 5199 (256GB) rows to ONE while the higher tiers stay distinct", () => {
    const rows = foldRetailerRows(danube, null);
    expect(rows.map((o) => o.price)).toEqual([5199, 5699, 6199, 7199]);
    // Idempotent: a second pass over the survivors changes nothing.
    expect(foldRetailerRows(rows, null)).toEqual(rows);
  });

  it("keeps-first on the sorted order (the cheapest live answer survives)", () => {
    const rows = foldRetailerRows(danube, null);
    expect(rows[0].url).toBe("https://danube.example/a");
  });

  it("different EFFECTIVE figures on one listed price stay separate (post-REEA-757)", () => {
    const twin = [
      offer({ merchant: "Jarir", price: 500, url: "https://jarir.example/x" }),
      offer({ merchant: "Jarir", price: 500, wasPrice: 450, url: "https://jarir.example/y" }),
    ];
    expect(foldRetailerRows(twin, null)).toHaveLength(2);
  });

  it("equal-after-evidence twins collapse: was-price folded onto the key", () => {
    const twin = [
      offer({ merchant: "Jarir", price: 450, url: "https://jarir.example/x" }),
      // The SAME achievable figure stated as listed-500 with a lower was-price:
      // the effective key folds the evidence, so the twin collapses.
      offer({ merchant: "Jarir", price: 500, wasPrice: 450, url: "https://jarir.example/y" }),
    ];
    const rows = foldRetailerRows(twin, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://jarir.example/x");
  });

  it("grade badges and merchant case fold on their own rules", () => {
    const rows = foldRetailerRows(
      [
        offer({ merchant: "Jarir", price: 499 }),
        offer({ merchant: "jarir", price: 499 }),
        offer({ merchant: "Jarir", price: 499, grade: "renewed-grade-b" }),
      ],
      null,
    );
    // Case-folded twins merge; the renewed listing keeps its own row.
    expect(rows).toHaveLength(2);
    expect(rows[1].grade).toBe("renewed-grade-b");
  });
});

describe("foldAlternativeRows — one card per product + figure", () => {
  it("collapses retailer spellings of ONE product at the SAME figure", () => {
    const out = foldAlternativeRows(alts);
    expect(out.map((a) => a.productId)).toEqual(["a", "c"]);
  });

  it("never merges different figures of one product", () => {
    const out = foldAlternativeRows([alts[0], { productId: "z", title: alts[0].title, fromPrice: 82 }]);
    expect(out).toHaveLength(2);
  });
});

describe("ProductResultCard rendered guards", () => {
  function card(offers: PriceOffer[], alternatives: ProductAlternative[] = []): NormalizedProduct {
    return {
      productId: "iphone-17-pro",
      title: "Apple iPhone 17 Pro",
      brand: "Apple",
      offers,
      coupons: [],
      variations: [],
      alternatives,
      scrapedAt: "2026-09-12T00:00:00.000Z",
    };
  }

  it("renders ONE Danube row for the three equal listings, tiers beside it", () => {
    const html = renderToString(
      <ProductResultCard product={card(danube, [])} query="iPhone 17 Pro" rank={0} />,
    );
    expect(html.match(/class="offer-row/g)?.length).toBe(4);
    expect(html).toContain("Danube Home");
    // The count line reads the SAME folded set the rows render (JSX text
    // seams serialize as comment pairs — match through them).
    expect(/tabular">4<\/span>\s*(?:<!-- -->)?retailers/.test(html)).toBe(true);
  });

  it("collapses duplicate alternatives into one card", () => {
    const html = renderToString(
      <ProductResultCard product={card([offer({ merchant: "Danube Home", price: 5199 })], alts)} rank={0} />,
    );
    expect(html.match(/href="\/results/g)?.length).toBe(2);
  });
});
