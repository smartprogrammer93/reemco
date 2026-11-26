/**
 * REEA-1218 (Bet 8) — Arabic query coverage.
 *
 * These pin the defect the live panel measured: an Arabic category/brand query
 * dispatched under its curated Latin alias (the retailers' indexes answer the
 * Latin spelling) but the Bet 7A relevance/scope gate could not read the
 * Arabic token, so every Latin-titled row became `accessory`/`consumable` and
 * the primary shelf rendered "لا توجد مطابقة" while the English equivalent
 * returned a full shelf.
 *
 * The tests cover the whole chain the ticket names: normalization (alef, taa
 * marbuta, ya, diacritics, definite article), the AR↔EN lexicon, the dispatch
 * alias, scope classification, identity evidence, relevance tiering, the
 * substitution line's data, and the Arabic empty-state suggestions.
 */
import "@/lib/collect/test-cache-dir";
import { describe, expect, it } from "vitest";
import {
  ARABIC_EMPTY_SUGGESTIONS,
  arabicPhraseAliasForQuery,
  arabicQueryAlias,
  foldArabicForMatch,
  normalizeArabicText,
} from "@/lib/arabic-lexicon";
import {
  carriesQueryIdentity,
  classifyProductScope,
  carriesFamilyAlias,
  queryProductClass,
} from "@/lib/scope-gate";
import {
  categoryIntent,
  latinBridgeDispatch,
  relevanceTier,
} from "@/lib/relevance";

const PANEL: Array<{ ar: string; en: string; title: string }> = [
  { ar: "غسالة", en: "washing machine", title: "LG Washing Machine 8kg Front Load" },
  { ar: "ثلاجة", en: "fridge", title: "Samsung Refrigerator 500L Silver" },
  { ar: "مكيف", en: "air conditioner", title: "Air Conditioner Split 1.5 Ton" },
  { ar: "جوال", en: "smartphone", title: "Samsung Galaxy S25 Ultra 256GB Phone" },
  { ar: "لابتوب", en: "laptop", title: "Acer Aspire 3 Laptop 15.6-inch" },
  { ar: "بانادول", en: "panadol", title: "Panadol Extra Pain Relief Tablets 24tablets" },
  { ar: "سامسونج", en: "samsung", title: "Samsung Galaxy S25 Ultra Phone" },
  { ar: "ايفون", en: "iphone", title: "Apple iPhone 17 Pro 256GB" },
  { ar: "سماعات", en: "headphones", title: "Sony WH-1000XM6 Wireless Headphones" },
  { ar: "سوني", en: "sony", title: "Sony WH-1000XM6 Wireless Headphones" },
  { ar: "مكنسة", en: "vacuum cleaner", title: "Dyson V15 Vacuum Cleaner" },
  { ar: "قدر ضغط", en: "pressure cooker", title: "Tefal Pressure Cooker 6L" },
];

describe("REEA-1218 — Arabic normalization", () => {
  it("folds alef variants, taa marbuta, ya and diacritics for matching", () => {
    expect(foldArabicForMatch("غسّالة")).toBe(foldArabicForMatch("غسالة"));
    expect(foldArabicForMatch("ثلاجة")).toBe(foldArabicForMatch("ثلاجه"));
    expect(foldArabicForMatch("مصطفى")).toBe(foldArabicForMatch("مصطفي"));
    expect(foldArabicForMatch("أرز")).toBe(foldArabicForMatch("ارز"));
    // The historical fold is kept for the identity/canonical callers.
    expect(normalizeArabicText("غــسالة")).toBe(normalizeArabicText("غسالة"));
  });

  it("resolves the definite article and the common misspellings to the same alias", () => {
    expect(latinBridgeDispatch("الغسالة")).toBe("washing machine");
    expect(latinBridgeDispatch("غسّالة")).toBe("washing machine");
    expect(latinBridgeDispatch("ثلاجه")).toBe("fridge");
    expect(latinBridgeDispatch("ال جي")).toBe("lg");
    expect(latinBridgeDispatch("نيكون")).toBe("nikon");
  });
});

describe("REEA-1218 — AR↔EN alias lexicon", () => {
  it("maps the fixed 12-query Arabic panel to the English spelling the retailers index", () => {
    for (const { ar, en } of PANEL) {
      expect(latinBridgeDispatch(ar)).toBe(en);
    }
  });

  it("is phrase-aware and exposes the substitution line's data", () => {
    const alias = arabicQueryAlias("قدر ضغط");
    expect(alias).not.toBeNull();
    expect(alias?.to).toBe("pressure cooker");
    expect(alias?.forms).toContain("pressure cooker");
    expect(arabicPhraseAliasForQuery("قدر ضغط")?.latin).toBe("pressure cooker");
    // A purely-Latin query is untouched and has no substitution line.
    expect(arabicQueryAlias("washing machine")).toBeNull();
    expect(latinBridgeDispatch("washing machine")).toBe("washing machine");
  });

  it("ships three concrete Arabic empty-state suggestions from the same lexicon", () => {
    expect(ARABIC_EMPTY_SUGGESTIONS).toHaveLength(3);
    for (const q of ARABIC_EMPTY_SUGGESTIONS) {
      expect(arabicQueryAlias(q)).not.toBeNull();
    }
  });
});

describe("REEA-1218 — scope gate reads the Arabic query", () => {
  it("classifies a Latin-titled row as primary under every panel query", () => {
    for (const { ar, title } of PANEL) {
      const verdict = classifyProductScope(ar, title);
      expect(
        verdict.productScope === "primary" || verdict.productScope === "variant",
        `${ar} → ${JSON.stringify(verdict)}`,
      ).toBe(true);
      expect(verdict.matchReason).not.toBe("related");
      expect(carriesQueryIdentity(ar, title)).toBe(true);
    }
  });

  it("keeps the class-intent path for Arabic category queries", () => {
    expect(queryProductClass("غسالة")).toBe("washing-machine");
    expect(queryProductClass("لابتوب")).toBe("laptop");
    expect(queryProductClass("سماعات")).toBe("headphones");
    expect(queryProductClass("جوال")).toBe("phones-tablets");
    expect(categoryIntent("غسالة")?.id).toBe("washing-machine");
    expect(categoryIntent("ايفون 17")).toBeNull(); // exact-model query
  });

  it("keeps the Panadol family alias and the Arabic brand evidence", () => {
    expect(carriesFamilyAlias("بانادول", "Panadol Extra Pain Relief Tablets")).toBe(true);
    expect(carriesFamilyAlias("بانادول", "Panadrex Tablets")).toBe(true);
    expect(carriesQueryIdentity("سامسونج", "Samsung Galaxy S25 Ultra")).toBe(true);
    expect(carriesQueryIdentity("سوني", "Sony WH-1000XM6 Headphones")).toBe(true);
  });

  it("does not demote accessories under an Arabic category query", () => {
    expect(classifyProductScope("جوال", "Samsung Galaxy S25 Ultra Phone").productScope).toBe("primary");
    expect(classifyProductScope("جوال", "Samsung Galaxy S25 Ultra Silicone Case").productScope).toBe("accessory");
    expect(classifyProductScope("لابتوب", "Acer Aspire 3 Laptop").productScope).toBe("primary");
    expect(classifyProductScope("لابتوب", "Laptop Backpack").productScope).toBe("accessory");
  });
});

describe("REEA-1218 — relevance tier reads the Arabic query", () => {
  it("scores the Latin-titled rows above tier 0 for every panel query", () => {
    for (const { ar, title } of PANEL) {
      expect(relevanceTier(ar, title), `${ar} → ${title}`).toBeGreaterThan(0);
    }
  });

  it("leaves the English panel and exact-model queries untouched", () => {
    expect(relevanceTier("iPhone 17 Pro", "Apple iPhone 17 Pro, 256 GB")).toBe(1);
    expect(relevanceTier("fold 7", "Samsung Galaxy Z Fold7 5G 256GB Phone - Blue")).toBeGreaterThan(0);
    expect(relevanceTier("laptop", "Acer Aspire 3 Laptop")).toBeGreaterThan(0);
    expect(classifyProductScope("laptop", "Acer Aspire 3 Laptop").productScope).toBe("primary");
    expect(classifyProductScope("panadol", "Panadol Extra Pain Relief Tablets").productScope).toBe("primary");
  });
});
