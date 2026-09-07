/**
 * REEA-114 — live query-time collection tests: hit extraction per retailer
 * contract, cross-retailer grouping, and the bounded fan-out with injected
 * fetch (one failing retailer must not lose the others' offers).
 */
import { describe, expect, it } from "vitest";
import {
  amazonEgHits,
  blinkHits,
  collectLiveResults,
  eurekaHits,
  groupHits,
  jarirHits,
  sultanCenterHits,
  xciteHits,
  type SearchHit,
} from "@/lib/collect/live-search";

describe("hit parsers", () => {
  it("xciteHits keeps scored hits with /p product URLs", () => {
    const payload = {
      results: [
        {
          hits: [
            { name: "Samsung Galaxy S26 Ultra 256GB", slug: "sg-s26u", price: 399, currency: "KWD", inStock: true, unmodifiedPrice: 429 },
            { name: "Unrelated Dock", slug: "dock", price: 9, currency: "KWD", inStock: true },
            { name: "Samsung Galaxy S26 Edge", slug: "s26e", price: 299, inStock: false },
          ],
        },
      ],
    };
    const hits = xciteHits(payload, "samsung");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ merchant: "Xcite", url: "https://www.xcite.com/sg-s26u/p", price: 399, wasPrice: 429 });
    expect(hits[1].inStock).toBe(false);
  });

  it("blinkHits reads Shopify variants", () => {
    const hits = blinkHits(
      { products: [{ title: "Samsung Galaxy S26", handle: "sg-s26", variants: [{ price: "350.00", available: true }] }] },
      "samsung galaxy s26",
    );
    expect(hits[0]).toMatchObject({ merchant: "Blink", price: 350, url: "https://blink.com.kw/products/sg-s26", inStock: true });
  });

  it("eurekaHits maps clprc/lprc and stock quantity", () => {
    const hits = eurekaHits(
      { hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9001", clprc: 380, lprc: 410, avaqt: 4 }] },
      "samsung",
    );
    // REEA-136 guardrail: canonical store route /products/details/<id>,
    // not the hard-404-ing /en/<Title>/<id> shape.
    expect(hits[0]).toMatchObject({
      price: 380,
      wasPrice: 410,
      inStock: true,
      url: "https://www.eureka.com.kw/products/details/9001",
    });
  });

  it("jarirHits reads Constructor metadata and keeps SAR", () => {
    const hits = jarirHits(
      { response: { results: [{ data: { url: "p/s26", price: "1499", metadata: { name: "Samsung Galaxy S26 Ultra" } } }] } },
      "samsung",
    );
    expect(hits[0]).toMatchObject({ merchant: "Jarir", price: 1499, currency: "SAR", url: "https://www.jarir.com/p/s26" });
  });

  it("sultanCenterHits maps product_list rows to direct store URLs", () => {
    // Fixture trimmed from the live mobile/api/search answer for "air fryer".
    const payload = {
      status: "1",
      products: {
        product_list: [
          {
            id: "79858",
            name: "Midea Air Fryer 11L MAD-110D2APK",
            sku: "303553260",
            price: "18.9900",
            spclprice: "",
            is_in_stock: "1",
            stock_quantity: "9",
            currencysymbol: "KD",
            slug: "midea-air-fryer-11l-black-11-l",
          },
          {
            id: "7",
            name: "Maggi Air Fryer Hot Buffalo Mix",
            price: "0.5000",
            spclprice: "0.4500",
            is_in_stock: "1",
            currencysymbol: "KD",
            slug: "maggi-air-fryer-hot-buffalo-mix-65-g",
          },
          { id: "8", name: "No Slug Item", price: "2.0000" },
        ],
      },
    };
    const hits = sultanCenterHits(payload, "air fryer");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      merchant: "Sultan Center",
      price: 18.99,
      currency: "KWD",
      url: "https://www.sultan-center.com/product/midea-air-fryer-11l-black-11-l",
      inStock: true,
    });
    // spclprice is the running promo: cheaper price wins, regular kept as wasPrice.
    expect(hits[1]).toMatchObject({ price: 0.45, wasPrice: 0.5 });
  });

  it("sultanCenterHits marks is_in_stock 0 as out of stock", () => {
    const hits = sultanCenterHits(
      { products: { product_list: [{ name: "Air Fryer Basket", slug: "basket", price: "3.0000", is_in_stock: "0" }] } },
      "air fryer",
    );
    expect(hits[0].inStock).toBe(false);
  });

  it("amazonEgHits parses cards with Arabic-Indic prices", () => {
    const html =
      'x data-component-type="s-search-result" <h2 aria-label="Samsung Galaxy S26 Ultra"><span>. </span></h2> ' +
      '<span class="a-offscreen">EGP ١٬٤٩٩٫٠٠</span><a href="/dp/B1234567">y</a> z';
    const hits = amazonEgHits(html, "samsung");
    expect(hits[0]).toMatchObject({ merchant: "Amazon.eg", price: 1499, currency: "EGP", url: "https://www.amazon.eg/dp/B1234567" });
  });
});

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    title: "Samsung Galaxy S26 Ultra",
    merchant: "Xcite",
    price: 399,
    currency: "KWD",
    url: "https://xcite.example/p",
    inStock: true,
    ...over,
  };
}

describe("groupHits", () => {
  it("merges the same title across retailers, cheapest first, in-stock first", () => {
    const products = groupHits("samsung", [
      hit({ merchant: "Jarir", price: 410, url: "https://jarir.example/s26" }),
      hit({ merchant: "Amazon.eg", price: 390, url: "https://amz.example/dp/1", currency: "EGP", inStock: false }),
      hit({ merchant: "Xcite", price: 399 }),
      hit({ title: "Samsung Monitor Odyssey", merchant: "Blink", price: 200, url: "https://blink.example/2" }),
    ]);
    expect(products).toHaveLength(2);
    const s26 = products.find((p) => p.title === "Samsung Galaxy S26 Ultra")!;
    const monitor = products.find((p) => p.title === "Samsung Monitor Odyssey")!;
    expect(s26.offers.map((o) => o.merchant)).toEqual(["Xcite", "Jarir", "Amazon.eg"]);
    expect(s26.alternatives.map((a) => a.title)).toContain("Samsung Monitor Odyssey");
    expect(monitor.offers).toHaveLength(1);
    // Real collection timestamp, not a computed offset — chips age honestly.
    expect(Date.parse(s26.scrapedAt!)).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - Date.parse(s26.scrapedAt!)).toBeLessThan(5_000);
  });
});

describe("collectLiveResults", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  it("collects from every retailer and survives one failure", async () => {
    const { products, notes } = await collectLiveResults("samsung", {
      fetchImpl: async (url) => {
        if (url.includes("blink.com.kw")) throw new Error("blink down");
        if (url.includes("xcite.com")) {
          return jsonResponse({
            results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }],
          });
        }
        if (url.includes("cnstrc.com") || url === "https://www.jarir.com/") {
          if (url.endsWith("jarir.com/")) {
            return new Response('x searchProviderKeys "key_test123456" y', { headers: { "content-type": "text/html" } });
          }
          return jsonResponse({ response: { results: [{ data: { url: "p/s26", price: 1499, metadata: { name: "Samsung Galaxy S26 Ultra" } } }] } });
        }
        if (url.endsWith("eureka.com.kw/")) {
          return new Response('<input id="cky" value="app"><input id="srcapk" value="key">', { headers: { "content-type": "text/html" } });
        }
        if (url.includes("algolia.net")) {
          return jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9001", clprc: 380, avaqt: 2 }] });
        }
        if (url.includes("sultan-center.com")) {
          return jsonResponse({
            status: "1",
            products: { product_list: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: "385.0000", is_in_stock: "1", currencysymbol: "KD" }] },
          });
        }
        return new Response('data-component-type="s-search-result" <h2 aria-label="Samsung Galaxy S26 Ultra"></h2><span class="a-offscreen">EGP 1,499</span><a href="/dp/B1234567">z</a>');
      },
    });
    expect(notes.some((n) => n.error === "blink down")).toBe(true);
    expect(products).toHaveLength(1);
    // Same exact title across retailers → one card carrying every live offer.
    expect(products[0].offers.length).toBeGreaterThanOrEqual(5);
    const merchants = new Set(products[0].offers.map((o) => o.merchant));
    expect(merchants.size).toBeGreaterThanOrEqual(5);
    // AC-1/AC-2 guard: the grocery + electronics depth merchants ship on the
    // same live path as the incumbents.
    expect(merchants.has("Eureka")).toBe(true);
    expect(merchants.has("Sultan Center")).toBe(true);
  });
});
