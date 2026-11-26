import { describe, expect, it } from "vitest";
import {
  canonicalProductIdForSlug,
  catalogProductIdFor,
  humanizeProductSlug,
  productTitleForId,
} from "@/lib/product-canonical";

/**
 * REEA-1189 — one canonical URL per product. The sitemap lists the stable
 * catalog ids; a live results card mints a merge slug for the same SKU. These
 * tests pin the fold: catalog-covered SKUs resolve to the sitemap id, and
 * distinct SKUs (other storage, another model line) never collapse.
 */
describe("canonical product identity for /product URLs", () => {
  it("folds a catalog-covered live SKU onto the sitemap's catalog id", () => {
    expect(
      catalogProductIdFor({ title: "Apple iPhone 17 Pro 256Gb Silver" }),
    ).toBe("iphone-17-pro");
    expect(canonicalProductIdForSlug("apple-iphone17-pro-256gb")).toBe(
      "iphone-17-pro",
    );
  });

  it("keeps the merge slug for a live-only SKU", () => {
    expect(canonicalProductIdForSlug("apple-iphone17-pro-512gb")).toBe(
      "apple-iphone17-pro-512gb",
    );
    // Pro Max is a different model line, not a storage sibling.
    expect(canonicalProductIdForSlug("apple-iphone17-pro-max-256gb")).toBe(
      "apple-iphone17-pro-max-256gb",
    );
  });

  it("leaves seeded catalog ids self-referencing", () => {
    expect(canonicalProductIdForSlug("iphone-17-pro")).toBe("iphone-17-pro");
    expect(canonicalProductIdForSlug("sony-wh-1000xm6")).toBe("sony-wh-1000xm6");
  });

  it("returns the catalog title for a seeded or folded id", () => {
    expect(productTitleForId("iphone-17-pro")).toBe("Apple iPhone 17 Pro 256GB");
    expect(productTitleForId("apple-iphone17-pro-512gb")).toBeNull();
  });

  it("humanizes a live-only slug into a product-specific title", () => {
    expect(humanizeProductSlug("apple-iphone17-pro-512gb")).toBe(
      "Apple iPhone 17 Pro 512GB",
    );
  });
});
