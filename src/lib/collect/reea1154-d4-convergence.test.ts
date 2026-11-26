/**
 * REEA-1154 / REEA-1068 D4 — the served head of a model query.
 *
 * QA measured the live box: `fold 7` / `fold7` / `Fold 7` served the Fold7
 * phones interleaved with accessory-only cards (#2 Uniq MagSafe case, #3 case,
 * #5 privacy protector, #6 anti-reflecting protector, #8 camera-lens
 * protector) and the AR spelling served a different Amazon listing. The two
 * causes pinned here:
 *
 *  1. the FRESH ranked path never applied the device-first head guard that
 *     memo/KV replays already use (skuLeadSnap → narrowDeviceLead), so
 *     selectAcrossRetailers' merchant round-robin put cheap accessories above
 *     the phones on a cold serve; and
 *  2. the memo identity forked on the request locale, so the Arabic spelling
 *     of the same dispatched query ran its own fan-out instead of sharing the
 *     one live answer.
 *
 * Both pins are on the pure/entry-point pieces so they cannot regress without
 * a red test.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { groupHits } from "@/lib/collect/live-search";
import { partitionByConfidence } from "@/lib/confidence";
import { queryCacheKey } from "@/lib/query-cache";
import { shelfSectionsFromProducts } from "@/lib/results-shelf";
import { dispatchIdentity, isAccessoryTitle } from "@/lib/relevance";
import type { SearchHit } from "@/lib/collect/live-search";

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "Samsung Galaxy S26 Ultra",
    merchant: "Xcite",
    price: 399,
    currency: "KWD",
    url: "https://xcite.example/p",
    inStock: true,
    country: "KW",
    ...over,
  };
}

/** The live shape QA measured: phones from the fast lanes plus the cheap
 *  accessory-only listings that led the head. */
const LIVE_SHAPE: SearchHit[] = [
  hit({ title: "Samsung Galaxy Z Fold7, 5G, 12 GB RAM", merchant: "Xcite", price: 379.9, url: "https://xcite.example/fold7-256" }),
  hit({ title: "Samsung Galaxy Z Fold7 5G 512Phone - Black", merchant: "Eureka", price: 399.9, url: "https://eureka.example/fold7-512" }),
  hit({ title: "Samsung Galaxy Z Fold7, 5G, 16 GB RAM, 1 TB", merchant: "Jarir", price: 465, url: "https://jarir.example/fold7-1tb" }),
  hit({ title: "Samsung Z Fold 7, 5G, 512 GB, 16 GB, 8\", W26 Chinese Version", merchant: "Blink", price: 950, url: "https://blink.example/fold7-w26" }),
  hit({ title: "Uniq Hybrid Lfepro Xtreme MagSafe Case for Samsung Galaxy Z Fold 7 - Crystal Clear", merchant: "Wibi", price: 4.05, url: "https://wibi.example/uniq-case" }),
  hit({ title: "Smartix Ultraguard Privacy Protector for Samsung Galaxy Z Fold 7 - Privacy", merchant: "Wibi", price: 4.65, url: "https://wibi.example/smartix-privacy" }),
  hit({ title: "Samsung Anti-Reflecting Screen Protector for Galaxy Z Fold7, EF-UF966CTEGWW - Clear", merchant: "Xcite", price: 4.5, url: "https://xcite.example/anti-reflect" }),
  hit({ title: "Panzerglass Camera Lens Protector For Galaxy Z Fold7 PG22394", merchant: "Eureka", price: 1.5, url: "https://eureka.example/pg22394" }),
  hit({ title: "for Samsung Z Fold 7 Case Clear, Compatible with MagSafe", merchant: "Amazon.eg", price: 191, url: "https://amazon.example/dp/case" }),
  // REEA-1154 D4, second pass — the served `fold 7` document headed with this
  // Amazon.eg cable at #2: no accessory marker matched "Cable", so the
  // device-first head guard classed it as a device. It belongs in this live
  // shape so the head pin below cannot pass again with a cable above the phones.
  hit({ title: "Heavy Duty 3 Meter Fast Charging 30W Cable USB A to Type-C", merchant: "Amazon.eg", price: 289.99, url: "https://amazon.example/dp/cable" }),
];

const SPELLINGS = ["fold 7", "fold7", "Fold 7", "فولد 7"];

describe("REEA-1154 D4 — the served head of a model query", () => {
  it("leads every spelling with the device set; no accessory card sits above a device", () => {
    for (const q of SPELLINGS) {
      const products = groupHits(q, LIVE_SHAPE);
      const firstAccessory = products.findIndex((p) => isAccessoryTitle(p.title));
      const lastDevice = products.reduce(
        (last, p, i) => (isAccessoryTitle(p.title) ? last : i),
        -1,
      );
      expect(firstAccessory, `${q}: an accessory leads the head`).toBeGreaterThan(lastDevice);
      // The Fold7 phone set leads, and none of it is an accessory card.
      const devices = products.filter((p) => !isAccessoryTitle(p.title));
      expect(devices.length, `${q}: phone cards collected`).toBeGreaterThanOrEqual(3);
      expect(
        products.slice(0, devices.length).every((p) => !isAccessoryTitle(p.title)),
        `${q}: device head`,
      ).toBe(true);
      // Accessories still render — the guard re-heads, never drops.
      expect(products.some((p) => isAccessoryTitle(p.title)), `${q}: accessories dropped`).toBe(true);
    }
  });

  it("serves one identical ordered set for all four spellings of the dispatched query", () => {
    const titles = SPELLINGS.map((q) => groupHits(q, LIVE_SHAPE).map((p) => p.title));
    for (const t of titles.slice(1)) expect(t).toEqual(titles[0]);
  });

  it("paints one identical primary shelf for every spelling — accessories demote to the related band", () => {
    // QA's 23:28Z pass on served `1d496613`: the follow-up feed returned the
    // same 10-product answer for all four spellings, but the RENDERED page
    // showed 4 cards for `fold 7` / `Fold 7` / `فولد 7` and 10 for `fold7`,
    // with the six accessory-only rows in the `fold7` primary shelf. The shelf
    // split is matchConfidence() over the raw spelling: "fold7" is code-shaped,
    // so the exact-SKU override kept its cases/protectors confident. The
    // partition must be spelling-invariant for one dispatched query.
    const snapshot = groupHits("fold7", LIVE_SHAPE);
    const sections = SPELLINGS.map((q) =>
      shelfSectionsFromProducts(snapshot, q, "KW", false),
    );
    const primaryIds = sections.map((s) => s.primary.map((p) => p.productId));
    for (const ids of primaryIds.slice(1)) expect(ids).toEqual(primaryIds[0]);
    // Primary is the device set only — every accessory row is below threshold.
    expect(primaryIds[0].length).toBeGreaterThanOrEqual(3);
    for (const s of sections) {
      expect(
        s.primary.every((p) => !isAccessoryTitle(p.title)),
        "an accessory card entered the primary shelf",
      ).toBe(true);
      expect(
        s.related.some((p) => isAccessoryTitle(p.title)),
        "the accessory band was emptied",
      ).toBe(true);
    }
  });

  it("passes an accessory-only answer set through untouched (an accessory query keeps its accessories)", () => {
    const cases = LIVE_SHAPE.filter((h) => isAccessoryTitle(h.title));
    const products = groupHits("fold7", cases);
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => isAccessoryTitle(p.title))).toBe(true);
  });

  it("does not re-head a query with no device intent — `foldable table` keeps its order", () => {
    const products = groupHits("foldable table", [
      hit({ title: "Wansa Glass Heater Foldable Table", merchant: "Xcite", price: 19.9, url: "https://xcite.example/table" }),
      hit({ title: "Naturehike FT07 Foldable Table", merchant: "Jarir", price: 25, url: "https://jarir.example/ft07" }),
    ]);
    expect(products.map((p) => p.title)).toEqual([
      "Wansa Glass Heater Foldable Table",
      "Naturehike FT07 Foldable Table",
    ]);
  });
});

describe("REEA-1154 D4 — one memo identity per dispatched query, across locales", () => {
  it("folds the EN spellings and the Arabic transliteration onto the same live answer", () => {
    expect(queryCacheKey("fold 7")).toBe("fold7");
    expect(queryCacheKey("Fold 7")).toBe(queryCacheKey("fold7"));
    expect(queryCacheKey("  fold   7 ")).toBe("fold7");
    expect(queryCacheKey("فولد 7")).toBe("fold7");
  });

  it("does not fork the identity on the request locale", () => {
    expect(queryCacheKey("فولد 7", null, "ar")).toBe(queryCacheKey("fold 7", null, "en"));
    expect(queryCacheKey("fold7", null, "ar")).toBe(queryCacheKey("fold7"));
  });

  it("keeps the country scope and leaves longer phrases with their own identity", () => {
    expect(queryCacheKey("fold7", "KW")).not.toBe(queryCacheKey("fold7"));
    expect(queryCacheKey("galaxy z fold 7")).toBe("galaxy z fold 7");
  });
});

describe("REEA-1154 D4 — the rendered shelf reads the dispatch identity", () => {
  it("folds every spelling onto one dispatch identity, and leaves longer phrases alone", () => {
    for (const q of SPELLINGS) expect(dispatchIdentity(q)).toBe("fold7");
    expect(dispatchIdentity("  fold   7 ")).toBe("fold7");
    expect(dispatchIdentity("galaxy z fold 7")).toBe("galaxy z fold 7");
    // The memo identity is the same dispatch identity the renderers read.
    expect(queryCacheKey("fold 7")).toBe(dispatchIdentity("fold 7"));
  });

  it("renders one identical primary shelf for all four spellings of the dispatch", () => {
    // QA measured the live defect: the tight spelling rendered 10 cards while
    // the spaced/title/AR spellings rendered 4 — the same accessory rows were
    // scored primary only under the tight spelling. The partition must read
    // the dispatch identity so one dispatched query paints one shelf: the
    // device set primary, the accessories in the related band below it.
    const products = groupHits("fold7", LIVE_SHAPE);
    const shelves = SPELLINGS.map((q) =>
      partitionByConfidence(q, products).primary.map((p) => p.title),
    );
    for (const shelf of shelves.slice(1)) expect(shelf).toEqual(shelves[0]);
    // The device set is primary; every accessory row is below threshold.
    expect(shelves[0].length).toBeGreaterThanOrEqual(3);
    expect(shelves[0].every((t) => !isAccessoryTitle(t))).toBe(true);
    // Accessories still render — below the phones, in the related band.
    const related = SPELLINGS.map((q) =>
      partitionByConfidence(q, products).related.map((p) => p.title),
    );
    for (const band of related.slice(1)) expect(band).toEqual(related[0]);
    expect(related[0].some((t) => isAccessoryTitle(t))).toBe(true);
  });

  it("keeps a genuine accessory query's accessories primary (no dispatch fold)", () => {
    // "iphone 17 case" is three tokens: it keeps its own spelling, so the
    // accessory demotion never applies to it.
    const products = groupHits("iphone 17 case", [
      hit({ title: "Apple iPhone 17 Pro Max Clear Case with MagSafe", merchant: "Xcite", price: 19 }),
      hit({ title: "Apple iPhone 17 Pro Max 256 GB", merchant: "Jarir", price: 459 }),
    ]);
    const { primary } = partitionByConfidence("iphone 17 case", products);
    expect(primary.some((p) => isAccessoryTitle(p.title))).toBe(true);
  });
});
