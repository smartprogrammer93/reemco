/**
 * REEA-963 R1 §8 — QA fixtures F-A..F-H per retailer adapter.
 *
 * Each fixture set runs the adapter's REAL response normalizer (xciteHits,
 * jarirHits, eurekaHits, sultanCenterHits, amazonEgHits) over a simulated
 * adapter payload, then pushes the parsed hits through the production
 * grouping + sanity pipeline (groupHits) and asserts the spec outcome.
 * This is test tooling ONLY — nothing here ships to users as data (company
 * data policy, spec §9): every fixture payload is constructed per test and
 * every asserted figure traces to that payload, never to a stored catalog.
 *
 * Fixture map (spec §8): F-A outlier_high · F-B outlier_low · F-C
 * currency_mis_map · F-D rollup_conflict · F-E variant_unclassified ·
 * F-F variant_family_ok · F-G tiny_cohort · F-H zero_price.
 */
import "./test-cache-dir";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@/lib/collect/live-search";
import {
  amazonEgHits,
  eurekaHits,
  groupHits,
  jarirHits,
  sultanCenterHits,
  xciteHits,
} from "@/lib/collect/live-search";
import { toKwdNumeric } from "@/lib/format";
import type { NormalizedProduct } from "@/types/product";

type Hits = SearchHit[];

const clone = (hits: Hits): Hits => hits.map((h) => ({ ...h }));

/** Device A (5 listings ~300) + a cheaper family mate B (250, 260, 128GB so
 *  the storage discriminator keeps the two cards apart — REEA-254). Each A
 *  listing carries a distinct qualifier token so the parsed listings survive
 *  the one-row-per-retailer+label fold (REEA-192/REEA-486) as five distinct
 *  rows; two carry real color tokens for the variant fixtures (F-E/F-F). */
const A_BASE = "Samsung Galaxy S26 Ultra 256GB";
const TITLES_A = [
  `${A_BASE} Black Middle East Version`,
  `${A_BASE} Silver GCC Version`,
  `${A_BASE} Usa Version`,
  `${A_BASE} Uk Version`,
  `${A_BASE} Eu Version`,
];
const A_PRICES = [290, 300, 315, 310, 320];
const TITLE_B = "Samsung Galaxy S26 128GB";
const B_PRICES = [250, 260];
const QUERY = "samsung galaxy s26";

function cardOf(products: NormalizedProduct[], needle: string, exclude?: string): NormalizedProduct {
  const p = products.find((x) => x.title.includes(needle) && !(exclude && x.title.includes(exclude)));
  if (!p) throw new Error(`fixture bug: no card for ${needle}`);
  return p;
}

/** True when `price` appears in NO variation row's implied figure
 *  (implied = card's cheapest non-flagged figure + the row's delta). */
function variantFiguresContain(p: NormalizedProduct, price: number, scale: number): boolean {
  const priced = p.offers.filter((o) => o.sanity?.status !== "flagged");
  if (priced.length === 0) return false;
  const cardBest = Math.min(...priced.map((o) => toKwdNumeric(o.price, o.currency)));
  return p.variations.some((v) => Math.abs(toKwdNumeric(cardBest + v.priceDelta, "KWD") - toKwdNumeric(price, "KWD")) < 0.01 * scale + 1e-9);
}

interface AdapterFixture {
  merchant: string;
  parse: () => Hits;
  /** KWD-space factor of the adapter's parsed currency (format.ts table). */
  scale: number;
  /** Scenario F-C's currency mislabel, applied to the parsed hits. */
  mislabel: (hits: Hits) => void;
}

const XCITE: AdapterFixture = {
  merchant: "Xcite",
  scale: 1,
  // currency rides the payload — the mislabel is constructible upstream.
  parse: () =>
    xciteHits(
      {
        results: [
          {
            hits: [
              ...TITLES_A.map((name, i) => ({
                name,
                slug: `s26u-${i}`,
                price: A_PRICES[i],
                currency: "KWD",
                inStock: true,
              })),
              { name: TITLE_B, slug: "s26-b1", price: B_PRICES[0], currency: "KWD", inStock: true },
              { name: TITLE_B, slug: "s26-b2", price: B_PRICES[1], currency: "KWD", inStock: true },
            ],
          },
        ],
      },
      QUERY,
    ),
  mislabel: (hits) => {
    hits[0].currency = "XYZ"; // KW host + unknown code: both mis-map paths
  },
};

const JARIR: AdapterFixture = {
  merchant: "Jarir",
  scale: 0.0816, // the parser stamps SAR (jarir.com contract)
  parse: () =>
    jarirHits(
      {
        response: {
          results: [
            ...TITLES_A.map((name, i) => ({
              data: { url: `p/s26u-${i}`, price: A_PRICES[i], metadata: { name } },
            })),
            { data: { url: "p/s26-b1", price: B_PRICES[0], metadata: { name: TITLE_B } } },
            { data: { url: "p/s26-b2", price: B_PRICES[1], metadata: { name: TITLE_B } } },
          ],
        },
      },
      QUERY,
    ),
  mislabel: (hits) => {
    hits[0].currency = "XYZ"; // upstream mislabel the parser cannot see
  },
};

const EUREKA: AdapterFixture = {
  merchant: "Eureka",
  scale: 1,
  parse: () =>
    eurekaHits(
      {
        hits: [
          ...TITLES_A.map((itmn, i) => ({ itmn, objectID: `900${i}`, clprc: A_PRICES[i] })),
          { itmn: TITLE_B, objectID: "90b1", clprc: B_PRICES[0] },
          { itmn: TITLE_B, objectID: "90b2", clprc: B_PRICES[1] },
        ],
      },
      QUERY,
    ),
  mislabel: (hits) => {
    hits[0].currency = "XYZ";
  },
};

const SULTAN: AdapterFixture = {
  merchant: "Sultan Center",
  scale: 1,
  // currencysymbol rides the payload — the mislabel is constructible upstream.
  parse: () =>
    sultanCenterHits(
      {
        products: {
          product_list: [
            ...TITLES_A.map((name, i) => ({
              name,
              slug: `s26u-${i}`,
              price: A_PRICES[i].toFixed(4),
              currencysymbol: "KD",
              is_in_stock: "1",
            })),
            { name: TITLE_B, slug: "s26-b1", price: "250.0000", currencysymbol: "KD" },
            { name: TITLE_B, slug: "s26-b2", price: "260.0000", currencysymbol: "KD" },
          ],
        },
      },
      QUERY,
    ),
  mislabel: (hits) => {
    hits[0].currency = "XYZ";
  },
};

const AMAZON_EG: AdapterFixture = {
  merchant: "Amazon.eg",
  scale: 0.0061,
  parse: () =>
    amazonEgHits(
      [...TITLES_A, TITLE_B, TITLE_B]
        .map((name, i) => {
          const price = [...A_PRICES, ...B_PRICES][i];
          return (
            `x data-component-type="s-search-result" ` +
            `<h2 aria-label="${name}"><span>. </span></h2> ` +
            `<span class="a-offscreen">EGP ${price.toLocaleString("en-US")}.00</span>` +
            `<a href="/dp/B123456${i}">y</a> z`
          );
        })
        .join(" "),
      QUERY,
    ),
  // THE AC-5 production shape: EGP values labeled KWD on the .eg host.
  mislabel: (hits) => {
    hits[0].currency = "KWD";
  },
};

const FIXTURES = [XCITE, JARIR, EUREKA, SULTAN, AMAZON_EG];
const kwdOf = (fx: AdapterFixture, price: number): number => toKwdNumeric(price, fx.merchant === "Jarir" ? "SAR" : fx.merchant === "Amazon.eg" ? "EGP" : "KWD");

afterEach(() => vi.restoreAllMocks());

describe("REEA-963 §8 adapter fixtures", () => {
  for (const fx of FIXTURES) {
    describe(`${fx.merchant}`, () => {
      it("F-A outlier_high: a 40× offer flags, stays visible, and never feeds a rollup (AC-1)", () => {
        const hits = clone(fx.parse());
        hits[0].price = hits[0].price * 40;
        const products = groupHits(QUERY, hits);
        const a = cardOf(products, "Ultra");
        const flagged = a.offers.filter((o) => o.sanity?.reason === "outlier_high");
        expect(flagged).toHaveLength(1);
        expect(flagged[0].price).toBe(hits[0].price); // stayed visible
        // Rollup exclusion: the flagged figure appears in NO alternatives
        // fromPrice on the page, and the family mate's rollup is untouched.
        const fromPrices = products.flatMap((p) => [
          ...p.alternatives.map((x) => x.fromPrice),
          ...(p.pairsWith ?? []).map((x) => x.fromPrice),
        ]);
        for (const fp of fromPrices) expect(fp).not.toBeCloseTo(kwdOf(fx, flagged[0].price), 0);
        const aAltB = a.alternatives.find((x) => x.title.includes("128GB"));
        expect(aAltB?.fromPrice).toBeCloseTo(kwdOf(fx, 250), 0);
      });

      it("F-B outlier_low: an absurd-cheap offer flags outlier_low and is excluded from the rollup (AC-1)", () => {
        const hits = clone(fx.parse());
        // The CHEAPEST family-mate listing becomes a 0.05× outlier: the
        // B-group rollup must then read 250, not the flagged ~2.
        hits[6].price = hits[6].price * 0.008;
        const products = groupHits(QUERY, hits);
        const b = cardOf(products, "128GB");
        const flagged = b.offers.filter((o) => o.sanity?.reason === "outlier_low");
        expect(flagged).toHaveLength(1);
        expect(flagged[0].price).toBe(hits[6].price); // stayed visible
        const a = cardOf(products, "Ultra");
        const aAltB = a.alternatives.find((x) => x.title.includes("128GB"));
        expect(aAltB).toBeDefined();
        expect(aAltB?.fromPrice).toBeCloseTo(kwdOf(fx, 250), 0); // NOT the flagged figure
      });

      it("F-C currency_mis_map: a mislabeled currency flags and stays out of rollups (AC-5)", () => {
        const hits = clone(fx.parse());
        fx.mislabel(hits);
        const products = groupHits(QUERY, hits);
        const all = products.flatMap((p) => p.offers);
        const mislabeled = all.find((o) => o.price === hits[0].price && o.merchant === fx.merchant);
        expect(mislabeled?.sanity).toMatchObject({ status: "flagged", reason: "currency_mis_map" });
        const fromPrices = products.flatMap((p) => p.alternatives.map((x) => x.fromPrice));
        for (const fp of fromPrices) expect(Math.abs(fp - kwdOf(fx, mislabeled?.price ?? NaN))).toBeGreaterThan(0.01);
      });

      it("F-D rollup_conflict: the same SKU twice with different prices renders ONE price — the freshest (AC-2, E5)", () => {
        const hits = clone(fx.parse());
        const twin = { ...hits[0], price: 999, collectedAt: "2026-09-14T12:00:00Z" };
        hits[0].collectedAt = "2026-09-14T09:00:00Z";
        hits.push(twin);
        const products = groupHits(QUERY, hits);
        const a = cardOf(products, "Ultra");
        const sameListing = a.offers.filter((o) => o.merchant === fx.merchant && o.url === hits[0].url);
        expect(sameListing).toHaveLength(1);
        expect(sameListing[0].price).toBe(999); // fresher fetch won
      });

      it("F-E variant_unclassified: unclassified offers never merge into variant rows (AC-4, FR-3.2)", () => {
        const hits = clone(fx.parse());
        // Black/Silver ship classified from the fixture set; hits[2] is
        // stripped to the bare model — no color token: UNCLASSIFIED.
        hits[2].title = A_BASE;
        const products = groupHits(QUERY, hits);
        const a = cardOf(products, "Ultra");
        expect(a.variations.length).toBeGreaterThanOrEqual(2);
        const colorIds = a.variations.map((v) => v.id.toLowerCase());
        expect(colorIds).toContain("black");
        expect(colorIds).toContain("silver");
        // The unclassified offer's figure appears in no variant row.
        expect(variantFiguresContain(a, hits[2].price, fx.scale)).toBe(false);
        // …and it still renders as an individual offer row (never dropped).
        expect(a.offers.some((o) => o.price === hits[2].price)).toBe(true);
      });

      it("F-F variant_family_ok: two classified colors render one row per color with correct prices (AC-3)", () => {
        const hits = clone(fx.parse());
        // Black (290) and Silver (300) ship classified from the fixture set.
        const products = groupHits(QUERY, hits);
        const a = cardOf(products, "Ultra");
        const black = a.variations.find((v) => v.id.toLowerCase() === "black");
        const silver = a.variations.find((v) => v.id.toLowerCase() === "silver");
        expect(black).toBeDefined();
        expect(silver).toBeDefined();
        expect(black?.needsVerification).toBeFalsy();
        expect(silver?.needsVerification).toBeFalsy();
        // Deltas ride the KWD-space effective key the rows sort on.
        expect(silver?.priceDelta).toBeCloseTo(
          Math.round((kwdOf(fx, hits[1].price) - kwdOf(fx, hits[0].price)) * 100) / 100,
          2,
        );
        expect(black?.priceDelta).toBeCloseTo(0, 2);
      });

      it("F-G tiny_cohort: 3 offers skip the outlier check, log it, flag nothing (FR-1.5, E1)", () => {
        const hits = clone(fx.parse()).slice(0, 3);
        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const products = groupHits(QUERY, hits);
        const logged = spy.mock.calls
          .map((c) => String(c[0]))
          .filter((s) => s.startsWith("[price-sanity]"))
          .map((s) => JSON.parse(s.slice("[price-sanity] ".length)) as Record<string, unknown>);
        expect(logged.length).toBeGreaterThan(0);
        for (const s of logged) {
          expect(s.outlierCheckSkipped).toBe(true);
          expect(s.queryId).toBe(QUERY);
        }
        for (const p of products) {
          for (const o of p.offers) expect(o.sanity?.status).not.toBe("flagged");
        }
      });

      it("F-H zero_price: a 0-price offer carries price_unavailable, never a KD 0 rollup (E3)", () => {
        const hits = clone(fx.parse());
        hits[0].price = 0; // upstream served a zero — the module must not bless it
        const products = groupHits(QUERY, hits);
        const a = cardOf(products, "Ultra");
        const zero = a.offers.find((o) => o.sanity?.reason === "price_unavailable");
        expect(zero).toBeDefined();
        expect(zero?.price).toBe(0);
        // It is excluded from every rollup figure on the page.
        const fromPrices = products.flatMap((p) => p.alternatives.map((x) => x.fromPrice));
        for (const fp of fromPrices) expect(fp).not.toBe(0);
      });
    });
  }
});
