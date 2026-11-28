/**
 * REEA-1268 — the static category registry behind the `/c/<slug>` browse
 * surface. These pins protect the shopper-facing contract:
 *  - exactly the eight approved slugs, each with a live seed-term list;
 *  - every entry links to `/c/<slug>` (never the `/results?q=` address the
 *    homepage module used to emit);
 *  - the membership guard keeps an off-category product off a shelf
 *    (a dishwasher is not a washing machine);
 *  - EN/AR copy parity and the locale plural agreement on the count line.
 */
import { describe, expect, it } from "vitest";
import {
  CATEGORY_SLUGS,
  CATEGORY_SURFACES,
  categoryBySlug,
  categoryHref,
  categoryMatchesTitle,
  categoryPageCopy,
  categoryShelfDef,
  isCategoryMember,
  liveCardsLabel,
} from "@/lib/categories";

describe("REEA-1268 D-1 — the eight approved category surfaces", () => {
  it("ships exactly the approved slugs in browse order", () => {
    expect(CATEGORY_SLUGS).toEqual([
      "laptops",
      "headphones",
      "air-fryers",
      "phones",
      "washing-machines",
      "refrigerators",
      "tv",
      "pharmacy",
    ]);
    expect(CATEGORY_SURFACES).toHaveLength(8);
  });

  it("gives every surface a live seed-term list and EN/AR labels", () => {
    for (const def of CATEGORY_SURFACES) {
      expect(def.queries.length).toBeGreaterThan(0);
      for (const term of def.queries) {
        expect(typeof term).toBe("string");
        expect(term.trim().length).toBeGreaterThan(0);
      }
      expect(def.label.en.length).toBeGreaterThan(0);
      expect(def.label.ar.length).toBeGreaterThan(0);
      expect(def.blurb.en.length).toBeGreaterThan(0);
      expect(def.blurb.ar.length).toBeGreaterThan(0);
      expect(def.label.en).not.toBe(def.label.ar);
    }
  });

  it("resolves slugs case-insensitively and 404s an unknown slug", () => {
    expect(categoryBySlug("laptops")?.slug).toBe("laptops");
    expect(categoryBySlug("  LAPTOPS ")?.slug).toBe("laptops");
    expect(categoryBySlug("category/laptops")).toBeNull();
    expect(categoryBySlug("airfryers")).toBeNull();
  });

  it("builds the one canonical category address", () => {
    for (const slug of CATEGORY_SLUGS) {
      expect(categoryHref(slug)).toBe(`/c/${slug}`);
    }
  });
});

describe("REEA-1268 — category membership guard", () => {
  it("keeps a dishwasher off the washing-machines shelf", () => {
    const def = categoryBySlug("washing-machines")!;
    expect(isCategoryMember("Bosch Washing Machine 9kg", def)).toBe(true);
    expect(isCategoryMember("Bosch Dishwasher 12 Place", def)).toBe(false);
  });

  it("keeps off-category products off the other shelves", () => {
    expect(isCategoryMember("Philips Air Fryer 1700W", categoryBySlug("air-fryers")!)).toBe(true);
    expect(isCategoryMember("Philips Blender 800W", categoryBySlug("air-fryers")!)).toBe(false);
    expect(isCategoryMember("Samsung 65 inch Smart TV", categoryBySlug("tv")!)).toBe(true);
    expect(isCategoryMember("Apple iPhone 17 Pro", categoryBySlug("phones")!)).toBe(true);
    expect(isCategoryMember("ASUS VivoBook 15 Laptop", categoryBySlug("laptops")!)).toBe(true);
    expect(isCategoryMember("Sony WH-1000XM6 Headphones", categoryBySlug("headphones")!)).toBe(true);
    // "Headphones" contains the letters "phone" but is not a phone: the phone
    // guard is word-bounded so the two browse surfaces never cross-count.
    expect(isCategoryMember("Sony WH-1000XM6 Headphones", categoryBySlug("phones")!)).toBe(false);
    expect(isCategoryMember("Samsung Refrigerator 500L", categoryBySlug("refrigerators")!)).toBe(true);
  });

  it("lets the pharmacy surface accept its seed terms' scoped shelf", () => {
    const def = categoryBySlug("pharmacy")!;
    expect(isCategoryMember("Panadol Extra 24 Tablets", def)).toBe(true);
    expect(isCategoryMember("Anything the pharmacy lane answers", def)).toBe(true);
    // The title-only classifier cannot attribute an arbitrary product to
    // pharmacy, so a homepage count never claims one.
    expect(categoryMatchesTitle("Panadol Extra 24 Tablets", def)).toBe(false);
  });
});

describe("REEA-1268 D-4 — EN/AR copy parity", () => {
  it("has every page-copy key in both locales", () => {
    const en = categoryPageCopy("en");
    const ar = categoryPageCopy("ar");
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(ar[key].length).toBeGreaterThan(0);
      expect(ar[key]).not.toBe(en[key]);
    }
  });

  it("uses the locale's count agreement", () => {
    expect(liveCardsLabel("en", 1)).toBe("1 live card");
    expect(liveCardsLabel("en", 6)).toBe("6 live cards");
    expect(liveCardsLabel("ar", 1)).toBe("بطاقة مباشرة واحدة");
    expect(liveCardsLabel("ar", 2)).toBe("بطاقتان مباشرتان");
    expect(liveCardsLabel("ar", 6)).toBe("6 بطاقات مباشرة");
    expect(liveCardsLabel("ar", 12)).toBe("12 بطاقة مباشرة");
  });
});

describe("REEA-1268 — the Client Component boundary", () => {
  it("hands the shelf only serializable fields (no match function)", () => {
    const def = categoryBySlug("laptops")!;
    const shelfDef = categoryShelfDef(def);
    expect(Object.keys(shelfDef).sort()).toEqual(["label", "queries", "slug"]);
    expect(typeof (shelfDef as { match?: unknown }).match).toBe("undefined");
    expect(shelfDef.slug).toBe("laptops");
    expect(shelfDef.queries).toEqual(def.queries);
    // The serialized shape round-trips through JSON unchanged.
    expect(JSON.parse(JSON.stringify(shelfDef))).toEqual(shelfDef);
  });
});
