/**
 * REEA-1140 — card ↔ PDP continuity, colour split and canonical stability.
 *
 * Live QA (REEA-1118, stamps eba496c / 33be78f) found three shopper-facing
 * trust defects on the merged shelf:
 *
 *  1. the card's "View all N offers" landed on a PDP with a different, smaller
 *     retailer set (HD16 5 → 1, DualSense 5 → 1, fold 7 512 4 → 5-but-wrong);
 *  2. "Sony PS5 DualSense Wireless Controller Alpine Green" still rendered as
 *     its own single-retailer card;
 *  3. the fold 7 256 GB card flipped between two `/product/...` slugs and the
 *     512 GB PDP rendered the 256 GB title.
 *
 * These pins cover the merge-map side: one canonical slug per merged SKU,
 * colourways fold into the card, and a different storage tier never blends.
 * The PDP resolution pins live in reea1140-resolution.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalFields,
  productSlugFor,
  storageFromListingUrl,
} from "@/lib/collect/canonical-product";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

function hit(title: string, merchant: string, price: number, url: string): SearchHit {
  return { title, merchant, price, currency: "KWD", url, inStock: true, country: "KW" };
}

describe("REEA-1140 — Alpine Green folds into the DualSense card", () => {
  it("recognises the official modifier + base colour pair", () => {
    const fields = canonicalFields("Sony PS5 DualSense Wireless Controller Alpine Green");
    expect(fields.modelLine).toBe("dualsense controller");
    expect(fields.color).toBe("green");
  });

  it("keeps one merged card instead of a standalone Alpine Green card", () => {
    const products = groupHits("ps5", [
      hit(
        "Sony PS5 DualSense Wireless Controller",
        "Wibi",
        20.9,
        "https://wibi.com.kw/products/sony-ps5-dualsense-wireless-controller-starlight-blue",
      ),
      hit(
        "Sony PS5 DualSense Wireless Controller Alpine Green",
        "Eureka",
        30.25,
        "https://www.eureka.com.kw/products/details/271678",
      ),
    ]);
    expect(products).toHaveLength(1);
    expect([...new Set(products[0].offers.map((o) => o.merchant))].sort()).toEqual([
      "Eureka",
      "Wibi",
    ]);
    // One canonical slug for the merged controller, colour-independent.
    // REEA-1162 — the platform now rides the identity as its own slot, so the
    // slug names the console the SKU is sold for; the colour still does not
    // fork it (Alpine Green and the base spelling share this slug).
    expect(products[0].productId).toBe("sony-dualsense-controller-ps5");
  });

  it("keeps a genuinely different controller model separate", () => {
    const products = groupHits("ps5", [
      hit(
        "Sony PS5 DualSense Wireless Controller",
        "Wibi",
        20.9,
        "https://wibi.com.kw/products/sony-ps5-dualsense-wireless-controller",
      ),
      hit(
        "Sony PS5 DualSense Edge Wireless Controller - White",
        "Eureka",
        34.9,
        "https://www.eureka.com.kw/products/details/edge",
      ),
    ]);
    expect(products).toHaveLength(2);
    expect(products.map((p) => p.productId).sort()).toEqual([
      "sony-dualsense-controller-ps5",
      "sony-dualsense-edge-controller-ps5",
    ]);
  });
});

describe("REEA-1140 — canonical slug comes from the merge identity, not a title", () => {
  it("pins the fold 7 256 GB slug even when the fetched title omits capacity", () => {
    const ramOnly = groupHits("fold 7", [
      hit(
        "Samsung Galaxy Z Fold7, 5G, 12 GB RAM",
        "Xcite",
        379.9,
        "https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p",
      ),
      hit(
        "Samsung Galaxy Z Fold7, 5G, 12 GB RAM",
        "Blink",
        385,
        "https://blink.com.kw/products/samsung-galaxy-z-fold7-5g-12-gb-ram-1",
      ),
    ]);
    // A collection that also fetched the capacity-bearing spelling must not
    // fork the slug: the identity is the same 256 GB tier.
    const withCapacity = groupHits("fold 7", [
      hit(
        "Samsung Galaxy Z Fold7, 5G, 12 GB RAM",
        "Xcite",
        379.9,
        "https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p",
      ),
      hit(
        "Samsung Galaxy Z Fold7 256GB 12GB Ram 5G Black",
        "Blink",
        385,
        "https://blink.com.kw/products/samsung-galaxy-z-fold7-5g-256gb-black",
      ),
    ]);
    expect(ramOnly).toHaveLength(1);
    expect(withCapacity).toHaveLength(1);
    expect(ramOnly[0].productId).toBe("samsung-galaxy-z-fold7-256gb");
    expect(withCapacity[0].productId).toBe("samsung-galaxy-z-fold7-256gb");
  });

  it("gives each fold 7 storage tier its own stable slug", () => {
    const products = groupHits("fold 7", [
      hit(
        "Samsung Galaxy Z Fold7, 5G, 12 GB RAM",
        "Xcite",
        379.9,
        "https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p",
      ),
      hit(
        "Samsung Galaxy Z Fold7  5G 512Phone - Black",
        "Xcite",
        399.9,
        "https://www.xcite.com/samsung-galaxy-z-fold7-5g-512gb-phone-blue/p",
      ),
      hit(
        "Samsung Galaxy Z Fold7, 5G, 16 GB RAM, 1 TB",
        "Blink",
        465,
        "https://blink.com.kw/products/samsung-galaxy-z-fold7-16-gb-ram-1-tb",
      ),
    ]);
    expect(products.map((p) => p.productId).sort()).toEqual([
      "samsung-galaxy-z-fold7-1tb",
      "samsung-galaxy-z-fold7-256gb",
      "samsung-galaxy-z-fold7-512gb",
    ]);
  });

  it("pins the HD16 slug regardless of which colour spelling arrived", () => {
    const pinkOnly = groupHits("dyson", [
      hit(
        "Dyson Supersonic Nural Hd16 - Ceramic Pink",
        "Zayoom",
        139,
        "https://zayoom.com/products/dyson-supersonic-nural-hd16-ceramic-pink",
      ),
    ]);
    const amberOnly = groupHits("dyson", [
      hit(
        "Dyson Supersonic Nural Hair Dryer HD16 Amber silk",
        "Eureka",
        119.95,
        "https://www.eureka.com.kw/products/details/250001",
      ),
    ]);
    expect(pinkOnly[0].productId).toBe("dyson-supersonic-nural-hd16");
    expect(amberOnly[0].productId).toBe("dyson-supersonic-nural-hd16");
  });

  it("never blends the 256 GB offers into the 512 GB card", () => {
    const products = groupHits("fold 7", [
      hit(
        "Samsung Galaxy Z Fold7, 5G, 12 GB RAM",
        "Xcite",
        379.9,
        "https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p",
      ),
      hit(
        "Samsung Galaxy Z Fold7  5G 512Phone - Black",
        "Eureka",
        526.7,
        "https://www.eureka.com.kw/products/details/265285",
      ),
    ]);
    const small = products.find((p) => p.productId === "samsung-galaxy-z-fold7-256gb")!;
    const large = products.find((p) => p.productId === "samsung-galaxy-z-fold7-512gb")!;
    expect(small.offers.map((o) => o.merchant)).toEqual(["Xcite"]);
    expect(large.offers.map((o) => o.merchant)).toEqual(["Eureka"]);
  });
});

describe("REEA-1140 — storage evidence from live listing URLs", () => {
  it("reads a capacity the retailer's own PDP slug names", () => {
    expect(
      storageFromListingUrl("https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p"),
    ).toBe("256gb");
    expect(
      storageFromListingUrl("https://www.xcite.com/samsung-galaxy-z-fold7-5g-512gb-phone-blue/p"),
    ).toBe("512gb");
  });

  it("never mistakes RAM for storage", () => {
    expect(storageFromListingUrl("https://blink.com.kw/products/samsung-galaxy-z-fold7-5g-12-gb-ram-1")).toBe("");
    expect(storageFromListingUrl("https://blink.com.kw/products/samsung-galaxy-z-fold7-16-gb-ram-1-tb")).toBe("1tb");
  });

  it("builds the same slug from the same identity + URLs every time", () => {
    const fields = canonicalFields("Samsung Galaxy Z Fold7, 5G, 12 GB RAM");
    const urls = ["https://www.xcite.com/samsung-galaxy-z-fold7-5g-256gb-phone-silver/p"];
    expect(productSlugFor(fields, urls, "Samsung Galaxy Z Fold7, 5G, 12 GB RAM")).toBe(
      "samsung-galaxy-z-fold7-256gb",
    );
    expect(productSlugFor(fields, urls, "Samsung Galaxy Z Fold7, 5G, 12 GB RAM")).toBe(
      "samsung-galaxy-z-fold7-256gb",
    );
  });
});
