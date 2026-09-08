/**
 * REEA-85 — retailer-search fallback parser tests.
 * Fixtures captured live from the retailer endpoints on 2026-09-05
 * (trimmed to the fields the parsers consume).
 */
import { describe, expect, it } from "vitest";
import {
  brandAwareCoverage,
  extractJarirIndexKey,
  jarirIndexLang,
  parseAmazonEgSearch,
  parseEurekaSearch,
  parseJarirSearch,
  parseShopifyProducts,
  parseSultanCenterSearch,
  parseXciteSearch,
  searchRetailerFallback,
  titleMatchScore,
  tokenCoverage,
} from "@/lib/collect/search-fallback";
import { domainOf } from "@/lib/collect/scraper";
import { CATALOG } from "@/lib/catalog";

const PRODUCT = "Sony WH-1000XM6 Wireless Noise Cancelling Headphones";

describe("titleMatchScore", () => {
  it("scores overlap and ignores tiny tokens", () => {
    expect(titleMatchScore("Sony WH-1000XM6 Wireless Headphones", PRODUCT)).toBeGreaterThan(0.5);
    expect(titleMatchScore("Apple iPhone case", PRODUCT)).toBeLessThan(0.2);
    expect(titleMatchScore("", PRODUCT)).toBe(0);
  });
});

describe("tokenCoverage (REEA-137 acceptance metric)", () => {
  const verbose =
    "Samsung Galaxy S25 Ultra, 256 GB, 12 GB RAM, Titanium Black, 5G, Snapdragon 8 Elite";

  it("a verbose title answering the query scores full coverage", () => {
    expect(tokenCoverage(verbose, "samsung")).toBe(1);
    // The symmetric score this replaced fell under the live-floor here — the
    // reason retailers vanished on one-word brand queries.
    expect(titleMatchScore(verbose, "samsung")).toBeLessThan(0.25);
  });

  it("an unrelated title scores zero regardless of title length", () => {
    expect(tokenCoverage("Anker PowerCore 20100 mAh Power Bank", "samsung")).toBe(0);
  });

  it("partial answers scale with the answered query tokens", () => {
    expect(tokenCoverage("Samsung Galaxy Book4 Laptop", "samsung galaxy s26 ultra")).toBeCloseTo(0.5);
    expect(tokenCoverage("", "samsung")).toBe(0);
  });
});

describe("parseXciteSearch", () => {
  const fixture = {
    results: [
      {
        hits: [
          {
            name: "Sony Wireless Noise Cancelling Headphones, WH1000XM5 - Black",
            slug: "sony-wireless-noise-cancelling-headphones-wh1000xm5-black",
            price: 79.9,
            unmodifiedPrice: 109.9,
            currency: "KWD",
            inStock: true,
            status_key: "InStock",
          },
          { name: "LG TV Stand", slug: "lg-tv-stand", price: 12 },
        ],
      },
    ],
  };

  it("picks the best-matching hit with provenance fields", () => {
    const found = parseXciteSearch(fixture, PRODUCT);
    expect(found?.price).toBe(79.9);
    expect(found?.currency).toBe("KWD");
    // REEA-115: xcite PDPs need the /p suffix — bare /{slug} soft-404s.
    expect(found?.url).toBe(
      "https://www.xcite.com/sony-wireless-noise-cancelling-headphones-wh1000xm5-black/p",
    );
    expect(found?.inStock).toBe(true);
    expect(found?.wasPrice).toBe(109.9);
  });

  it("returns null when no hit matches", () => {
    expect(parseXciteSearch({ results: [{ hits: [] }] }, PRODUCT)).toBeNull();
    expect(parseXciteSearch(null, PRODUCT)).toBeNull();
  });
});

describe("parseShopifyProducts", () => {
  const fixture = {
    products: [
      {
        title: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
        handle: "sony-wh-1000xm6-black",
        variants: [{ price: "149.900", available: false }],
      },
      { title: "Gift Card", handle: "gift-card", variants: [{ price: "5.000" }] },
    ],
  };

  it("maps the best-matching product and stock state", () => {
    const found = parseShopifyProducts(fixture, PRODUCT);
    expect(found?.price).toBeCloseTo(149.9);
    expect(found?.url).toBe("https://blink.com.kw/products/sony-wh-1000xm6-black");
    expect(found?.inStock).toBe(false);
  });

  it("defaults inStock true when the variant omits availability", () => {
    const p = {
      products: [
        {
          title: "Sony WH-1000XM6 Headphones",
          handle: "sony-xm6",
          variants: [{ price: "100.000" }],
        },
      ],
    };
    expect(parseShopifyProducts(p, PRODUCT)?.inStock).toBe(true);
  });
});

describe("parseEurekaSearch", () => {
  const fixture = {
    hits: [
      {
        itmn: "Sony Wireless Noise Cancelling Headphone WH1000XM6 Black",
        objectID: "275100",
        lprc: 126.533,
        clprc: 94.9,
        avaqt: 3,
      },
      { itmn: "Samsung Charger", objectID: "1", clprc: 2 },
    ],
  };

  it("maps title/price/stock and the PDP url shape", () => {
    const found = parseEurekaSearch(fixture, PRODUCT);
    expect(found?.price).toBe(94.9);
    expect(found?.wasPrice).toBe(126.533);
    expect(found?.inStock).toBe(true);
    expect(found?.url).toBe(
      "https://www.eureka.com.kw/products/details/275100",
    );
  });

  it("treats avaqt 0 as out of stock", () => {
    const p = { hits: [{ ...fixture.hits[0], avaqt: 0 }] };
    expect(parseEurekaSearch(p, PRODUCT)?.inStock).toBe(false);
  });
});

describe("extractJarirIndexKey", () => {
  const html =
    '<script type="application/json" id="__NUXT_DATA__">[{"siteConfig":{"searchProviderKeys":{"ar":2,"en":3}},"key_g0Gi7pKaE5cyqDGl","key_KcSYfmQTEwRpBnd9"]</script>';

  it("picks the English index key (last literal)", () => {
    expect(extractJarirIndexKey(html)).toBe("key_KcSYfmQTEwRpBnd9");
  });

  it("falls back to the single key when only one is present", () => {
    expect(extractJarirIndexKey('{"en":"key_SingleOnly123"}')).toBe("key_SingleOnly123");
  });

  it("returns null without any key literal", () => {
    expect(extractJarirIndexKey("<html>no payload</html>")).toBeNull();
  });

  it("answers Arabic-script queries from the Arabic index (REEA-195)", () => {
    // {ar,en} reference order: the FIRST literal is the Arabic index — the
    // one that returns Arabic titles with a populated brand field. Latin
    // queries keep the English pick above.
    expect(extractJarirIndexKey(html, "ar")).toBe("key_g0Gi7pKaE5cyqDGl");
    expect(jarirIndexLang("سماعة أبل")).toBe("ar");
    expect(jarirIndexLang("fold7")).toBe("en");
  });
});

describe("brandAwareCoverage (REEA-195)", () => {
  it("bridges the Arabic brand spelling to the curated Latin form", () => {
    // أبل ⇄ Apple answers one of the two query tokens on a Latin title:
    // above the 0.25 live-floor, so English-index retailers stop vanishing
    // from Arabic queries. Unrelated titles still score 0.
    expect(brandAwareCoverage("Apple Airpods 4 - White", "سماعة أبل")).toBeCloseTo(0.5);
    expect(brandAwareCoverage("Anker PowerCore 20100 mAh", "سماعة أبل")).toBe(0);
  });

  it("Latin queries and Arabic-on-Arabic matching keep the plain path", () => {
    expect(brandAwareCoverage("Samsung Galaxy Buds FE", "سامسونج")).toBe(1);
    expect(brandAwareCoverage("سماعة القرآن للأطفال", "سماعة أبل")).toBeCloseTo(0.5);
    expect(brandAwareCoverage("Sony WH-1000XM6", "sony")).toBe(1);
  });
});

describe("parseJarirSearch", () => {
  const fixture = {
    response: {
      results: [
        {
          data: {
            sku: "632169",
            url: "asus-rog-strix-keyboard-mouse-combo-632169.html",
            price: 499,
            metadata: { name: "Asus ROG Strix Scope II RX Mechanical RGB Gaming Keyboard", price: "499.000000" },
          },
        },
        {
          data: {
            sku: "1",
            url: "wd-black-sn770m.html",
            price: 3200,
            metadata: { name: "WD Black SN770M NVMe Internal SSD" },
          },
        },
      ],
    },
  };

  it("maps the best Constructor hit to a FoundOffer", () => {
    const found = parseJarirSearch(fixture, "ASUS ROG Strix Scope II 96 Wireless");
    expect(found?.price).toBe(499);
    expect(found?.currency).toBe("SAR");
    expect(found?.url).toBe("https://www.jarir.com/asus-rog-strix-keyboard-mouse-combo-632169.html");
    expect(found?.inStock).toBe(true);
  });

  it("returns null when no hit clears the relevance bar", () => {
    expect(parseJarirSearch({ response: { results: [] } }, PRODUCT)).toBeNull();
    expect(parseJarirSearch(null, PRODUCT)).toBeNull();
  });
});

describe("parseAmazonEgSearch", () => {
  const card = (asin: string, price: string, title: string, extra = "") =>
    `<div data-component-type="s-search-result"><h2 aria-label="${title}" class="a-size-base"><span>${title}</span></h2>` +
    `<span class="a-offscreen">‏${price} جنيه</span><a href="/%D9%85/dp/${asin}/ref=sr_1_1">${extra}</a></div>`;

  const fixture =
    card("B0DPWX3WTL", "3,957.00", "لوحة مفاتيح ميكانيكية اكس اولا F75 ماكس", "") +
    card("B0FX2P81BG", "1,299.00", "كيكرون كيبورد ميكانيكي سلكي Keychron V3 Max QMK", "") +
    card("B0ZZZZZZZZ", "45.00", "USB Cable");

  it("picks the best token coverage over Arabic/Latin mixed titles", async () => {
    const html = await Promise.resolve(fixture);
    const found = parseAmazonEgSearch(html, "Keychron V3 Max QMK Wireless Mechanical Keyboard");
    expect(found?.price).toBeCloseTo(1299);
    expect(found?.currency).toBe("EGP");
    expect(found?.url).toBe("https://www.amazon.eg/dp/B0FX2P81BG");
    expect(found?.inStock).toBe(true);
  });

  it("falls back to the first priced organic card when nothing covers the title", () => {
    const found = parseAmazonEgSearch(fixture, "Totally Unknown Brand Model 9000");
    expect(found?.url).toBe("https://www.amazon.eg/dp/B0DPWX3WTL");
  });

  it("returns null when no card carries both ASIN and price", () => {
    expect(parseAmazonEgSearch("<html>none</html>", PRODUCT)).toBeNull();
  });
});

describe("parseSultanCenterSearch", () => {
  // Fixture trimmed from the live mobile/api/search answer (2026-09-07).
  const fixture = {
    status: "1",
    products: {
      product_list: [
        {
          name: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
          slug: "sony-wh-1000xm6-wireless-noise-cancelling-headphones",
          price: "44.9000",
          spclprice: "",
          is_in_stock: "1",
          stock_quantity: "6",
          currencysymbol: "KD",
        },
        { name: "Air Freshener", slug: "air-freshener", price: "1.0000", is_in_stock: "1" },
      ],
    },
  };

  it("maps the best product_list row to a direct store URL", () => {
    const found = parseSultanCenterSearch(fixture, PRODUCT);
    expect(found?.price).toBeCloseTo(44.9);
    expect(found?.currency).toBe("KWD");
    expect(found?.url).toBe(
      "https://www.sultan-center.com/product/sony-wh-1000xm6-wireless-noise-cancelling-headphones",
    );
    expect(found?.inStock).toBe(true);
  });

  it("returns null when no row clears the relevance bar", () => {
    expect(parseSultanCenterSearch({ products: { product_list: [] } }, PRODUCT)).toBeNull();
    expect(parseSultanCenterSearch(null, PRODUCT)).toBeNull();
  });
});

describe("searchRetailerFallback dispatch", () => {
  it("resolves jarir.com via homepage key + Constructor query", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("ac.cnstrc.com")) {
        return new Response(
          JSON.stringify({
            response: {
              results: [
                { data: { url: "a.html", price: 499, metadata: { name: "Asus ROG Strix Scope II RX" } } },
              ],
            },
          }),
        );
      }
      return new Response('[{"searchProviderKeys":{"ar":1,"en":2}},"key_aaa111","key_bbb222"]');
    };
    const found = await searchRetailerFallback("jarir.com", "ASUS ROG Strix Scope II", fetchImpl);
    expect(found.price).toBe(499);
    expect(found.currency).toBe("SAR");
  });

  it("resolves sultan-center.com via the store-scoped mobile search API", async () => {
    const sent: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      sent.push(String(init?.body));
      return new Response(
        JSON.stringify({
          status: "1",
          products: { product_list: [{ name: "Sony WH-1000XM6 Headphones", slug: "sony-xm6", price: "44.9000", is_in_stock: "1", currencysymbol: "KD" }] },
        }),
      );
    };
    const found = await searchRetailerFallback("sultan-center.com", "Sony WH-1000XM6 Headphones", fetchImpl);
    const body = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    expect(body.search_data).toBe("Sony WH-1000XM6 Headphones");
    expect(body.store_type).toBe("ecom");
    expect(found.url).toBe("https://www.sultan-center.com/product/sony-xm6");
    expect(found.price).toBeCloseTo(44.9);
    expect(found.currency).toBe("KWD");
  });

  it("resolves amazon.eg from the /s results page", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        '<div data-component-type="s-search-result"><h2><span>Keychron V3 Max QMK</span></h2>' +
          '<span class="a-offscreen">‏1,299.00 جنيه</span><a href="/dp/B0FX2P81BG/x"></a></div>',
      );
    const found = await searchRetailerFallback(
      "amazon.eg",
      "Keychron V3 Max QMK Wireless Mechanical Keyboard",
      fetchImpl,
    );
    expect(found.price).toBeCloseTo(1299);
    expect(found.url).toBe("https://www.amazon.eg/dp/B0FX2P81BG");
  });

  it("retries amazon.eg once when the apology interstitial comes back", async () => {
    let calls = 0;
    let seenHeaders: Headers | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      seenHeaders = new Headers(init?.headers);
      if (calls === 1) return new Response("<html><title>عذرًا!</title></html>");
      return new Response(
        '<div data-component-type="s-search-result"><h2><span>ASUS ROG Strix Scope II 96 Wireless</span></h2>' +
          '<span class="a-offscreen">EGP 3,957.00</span><a href="/dp/B0FX2P81BG/x"></a></div>',
      );
    };
    const found = await searchRetailerFallback(
      "amazon.eg",
      "ASUS ROG Strix Scope II 96 Wireless Gaming Keyboard",
      fetchImpl,
    );
    expect(calls).toBe(2);
    expect(seenHeaders?.get("accept-language")).toBe("en");
    expect(found.price).toBeCloseTo(3957);
  });
});

describe("seed catalog dispatch routing (REEA-93)", () => {
  it("routes jarir/amazon.eg offers to their own hosts, not a search redirector", () => {
    let checked = 0;
    for (const product of CATALOG) {
      for (const offer of product.offers) {
        const host = domainOf(offer.url);
        if (offer.merchant.startsWith("Jarir")) {
          expect(host).toBe("jarir.com");
          checked += 1;
        }
        if (offer.merchant.startsWith("Amazon.eg")) {
          expect(host).toBe("amazon.eg");
          checked += 1;
        }
      }
    }
    // Guard: the assertions above must actually run against the seeded data.
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe("discovery-hop allowlist (REEA-224 F3)", () => {
  function html(body: string): Response {
    return new Response(body, { headers: { "content-type": "text/html" } });
  }

  it("lets a well-formed eureka credential pair reach only the *-dsn.algolia.net hop", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url);
      if (url.endsWith("eureka.com.kw/")) {
        return html('<input id="cky" value="5GPHMAA239"><input id="srcapk" value="key4eureka">');
      }
      return new Response(JSON.stringify({ hits: [] }));
    };
    await searchRetailerFallback("eureka.com.kw", PRODUCT, fetchImpl).catch(() => null);
    // Discovery passed the shared REEA-152 allowlist, so the follow-up hop is
    // the plain Algolia origin — the app id only ever shrank the suffix.
    expect(seen.some((u) => u.startsWith("https://5GPHMAA239-dsn.algolia.net/"))).toBe(true);
  });

  it("fails closed on crafted eureka credentials before interpolating them", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url);
      // Crafted homepage: appId carries an origin + query + fragment; the
      // searchKey is well-formed so only the allowlist check can trip here.
      return html('<input id="cky" value="evil.example/?a#"><input id="srcapk" value="validkey12">');
    };
    await expect(
      searchRetailerFallback("eureka.com.kw", PRODUCT, fetchImpl),
    ).rejects.toThrow("eureka: discovery credentials failed validation");
    // Homepage fetched once; the crafted value never entered a hop URL.
    expect(seen).toHaveLength(1);
    expect(seen.join(" ")).not.toContain("evil.example");
  });
});
