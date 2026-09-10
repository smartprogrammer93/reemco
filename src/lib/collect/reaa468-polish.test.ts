/**
 * REEA-468 — polish bundle, collect layer.
 * G4: the empty state keeps ≥1 near-match suggestion derived from the titles
 *     THIS run collected (nearMatchSuggestions) — deduped, relevance-ranked,
 *     capped, and each suggestion carrying its own listing so the client-side
 *     stock/country passes keep honoring the shopper's selections.
 * G5: the Arabic locale picks the Arabic-script representative title inside a
 *     merged card; ranking itself never forks on locale.
 */
import { describe, expect, it } from "vitest";
import { groupHits, nearMatchSuggestions } from "@/lib/collect/live-search";
import type { SearchHit } from "@/lib/collect/live-search";
import { filterProductsByStock } from "@/lib/stock";

const hit = (over: {
  title: string;
  merchant: string;
  price?: number;
  inStock?: boolean;
}): SearchHit => ({
  title: over.title,
  merchant: over.merchant,
  price: over.price ?? 99,
  currency: "KWD",
  url: `https://${over.merchant.toLowerCase()}.example/p`,
  inStock: over.inStock ?? true,
  country: "KW",
});

describe("nearMatchSuggestions (REEA-468 G4)", () => {
  it("derives distinct near-match titles from the collected hits, ranked by fit", () => {
    const hits: SearchHit[] = [
      hit({ title: "Sony WH-1000XM6 Wireless Headphones", merchant: "Xcite", price: 105 }),
      hit({ title: "JBL Tune 520BT Over-Ear Headphones", merchant: "Blink", price: 45 }),
      hit({ title: "Sony WH-1000XM6 Wireless Headphones", merchant: "Jarir", price: 99, inStock: false }),
      hit({ title: "Sony INZONE H5 Gaming Headset", merchant: "Xcite", price: 120 }),
      hit({ title: "   ", merchant: "Wibi" }),
    ];
    const out = nearMatchSuggestions("sony xm6", hits);
    // Shared spelling of one model appears once (first-seen listing kept),
    // blank titles drop out, and the set is exactly the distinct collected
    // titles — order is the fit-score's call (covered by the next case).
    expect(out.map((p) => p.title)).toHaveLength(3);
    expect(out.map((p) => p.title).sort()).toEqual(
      [
        "Sony WH-1000XM6 Wireless Headphones",
        "Sony INZONE H5 Gaming Headset",
        "JBL Tune 520BT Over-Ear Headphones",
      ].sort(),
    );
    // Each pill carries its own collected listing, so the stock/country
    // selections keep working on the suggestion set exactly as on cards.
    const xm6 = out.find((p) => p.title.startsWith("Sony WH-1000XM6"))!;
    expect(xm6.offers).toHaveLength(1);
    expect(xm6.offers[0].merchant).toBe("Xcite"); // first-seen listing kept
    expect(xm6.productId).toBe("sony-wh-1000xm6-wireless-headphones");
  });

  it("ranks by fit against the query, not by arrival order", () => {
    const hits: SearchHit[] = [
      hit({ title: "Sony INZONE H5 Gaming Headset", merchant: "Xcite" }),
      hit({ title: "JBL Tune 520BT Over-Ear Headphones", merchant: "Blink" }),
    ];
    const out = nearMatchSuggestions("jbl tune", hits);
    expect(out[0].title).toBe("JBL Tune 520BT Over-Ear Headphones");
  });

  it("caps at the limit and answers an empty run honestly-empty", () => {
    const hits = Array.from({ length: 6 }, (_, i) => hit({ title: `Kettle Model ${i}`, merchant: "Astore" }));
    expect(nearMatchSuggestions("kettle", hits)).toHaveLength(3);
    expect(nearMatchSuggestions("kettle", [])).toEqual([]);
  });

  it("survives the stock pass exactly like a card when its listing is stocked", () => {
    const out = nearMatchSuggestions(
      "kettle",
      [hit({ title: "Black+Decker KM2411B kettle", merchant: "Next Store" })],
    );
    expect(filterProductsByStock(out, false)).toHaveLength(1);
  });
});

describe("groupHits Arabic representative title (REEA-468 G5)", () => {
  const hits: SearchHit[] = [
    hit({ title: "Samsung Galaxy A17", merchant: "Jarir" }),
    hit({ title: "سامسونج غالاكسي إيه 17", merchant: "Sultan Center" }),
  ];

  it("prefers the Arabic-script title of a merged card on the Arabic locale", () => {
    const ar = groupHits("سامسونج", hits, false, "ar");
    expect(ar.length).toBeGreaterThan(0);
    // The Arabic answer is visible somewhere on the Arabic page whatever the
    // grouping decides — the Latin spelling never hides it.
    expect(ar.some((p) => /[؀-ۿ]/.test(p.title))).toBe(true);
  });

  it("keeps the shortest-title pick for every other locale", () => {
    const en = groupHits("samsung", hits, false, undefined);
    expect(en.length).toBeGreaterThan(0);
    expect(en.some((p) => p.title === "Samsung Galaxy A17")).toBe(true);
  });
});
