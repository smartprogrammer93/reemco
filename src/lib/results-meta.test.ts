import { describe, expect, it } from "vitest";
import { buildResultsMeta } from "./results-meta";
import { resolveUiLocale } from "./i18n";

/**
 * REEA-400 — guardrails for the per-query results metadata. These prove the
 * acceptance shape without a server: the title carries the query and varies
 * per query, the locale chain switches the whole title to Arabic (matching
 * the brief's "أسعار <query> في الكويت - ريمكو"), a stated market moves the
 * country segment, and the description follows the same query/locale.
 */
describe("buildResultsMeta (results-page SEO metadata)", () => {
  it("puts the query and country into the English title and description", () => {
    const meta = buildResultsMeta({ query: "iPhone 17 Pro", country: null, locale: "en" });
    expect(meta.title).toBe("iPhone 17 Pro prices in Kuwait - Reemco");
    expect(meta.description).toContain("iPhone 17 Pro");
    expect(meta.description).toContain("Kuwait");
  });

  it("varies the title per query", () => {
    const a = buildResultsMeta({ query: "WH-1000XM6", country: null, locale: "en" });
    const b = buildResultsMeta({ query: "scope ii keyboard", country: null, locale: "en" });
    expect(a.title).toBe("WH-1000XM6 prices in Kuwait - Reemco");
    expect(b.title).toBe("scope ii keyboard prices in Kuwait - Reemco");
    expect(a.title).not.toBe(b.title);
  });

  it("ships the Arabic pattern for the ar locale", () => {
    const meta = buildResultsMeta({ query: "آيفون 17", country: null, locale: "ar" });
    expect(meta.title).toBe("أسعار آيفون 17 في الكويت - ريمكو");
    expect(meta.description).toContain("آيفون 17");
  });

  it("honors a stated market selection in both locales", () => {
    const en = buildResultsMeta({ query: "LG C3 OLED", country: "SA", locale: "en" });
    const ar = buildResultsMeta({ query: "LG C3 OLED", country: "SA", locale: "ar" });
    expect(en.title).toBe("LG C3 OLED prices in Saudi Arabia - Reemco");
    expect(ar.title).toBe("أسعار LG C3 OLED في السعودية - ريمكو");
  });

  it("falls back to a market-scoped title when no query is stated", () => {
    const meta = buildResultsMeta({ query: "", country: null, locale: "en" });
    expect(meta.title).toBe("all products prices in Kuwait - Reemco");
    expect(meta.title).toContain("Reemco");
  });

  it("an Arabic query with no cookie and no Accept-Language gets the Arabic template (REEA-448 G2)", () => {
    // Exactly what the page's generateMetadata composes: the request-time
    // chain over the request's own signals, then buildResultsMeta over it.
    const locale = resolveUiLocale(undefined, null, "آيفون");
    const meta = buildResultsMeta({ query: "آيفون", country: null, locale });
    expect(meta.title).toBe("أسعار آيفون في الكويت - ريمكو");
    // The mixed "آيفون prices in Kuwait - Reemco" pair was the shipped bug:
    // an Arabic-script query must never compose onto the English template.
    expect(meta.title).not.toContain("prices in");
  });
});
