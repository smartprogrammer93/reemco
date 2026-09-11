/**
 * REEA-262 — adapter-dispatch coverage for the four stores added after the
 * original six retailers (QA repro on the live site 2026-09-08: only Blink of
 * the new five appeared; Lulu Hypermarket, Quadra Stores, Next Store and
 * PC Kuwait were absent from the SSR notes, the hydration waves and the
 * product pages). The guard this test encodes: the staged dispatcher must
 * SCHEDULE every adapter in COLLECTORS and the converged snapshot must carry
 * a per-retailer note with a real answer for each of them — silent drops of
 * the tail adapters (scheduled-last, never flushed) are exactly what a
 * truncated stage list would cause.
 */
import { describe, expect, it } from "vitest";
import { collectLiveResultsStaged, resetDiscoveryCache } from "@/lib/collect/live-search";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

/** One documented-contract answer per retailer hop, Nescafe-relevant titles. */
const fetchImpl = async (url: string): Promise<Response> => {
  if (url.includes("xcite.com/api/algolia")) {
    return jsonResponse({
      results: [
        { hits: [{ name: "Nescafe Classic Coffee 50g", slug: "nescafe-classic-50", price: 2.5, currency: "KWD", inStock: true }] },
      ],
    });
  }
  if (url.includes("blink.com.kw")) {
    return jsonResponse({
      products: [{ title: "Nescafe Classic Coffee 50g", handle: "nescafe-classic-coffee", variants: [{ price: "2.350", available: true }] }],
    });
  }
  if (url.includes("quadrastores.com")) {
    return jsonResponse({
      products: [
        { title: "Nescafe Classic Coffee 50g", handle: "nescafe-classic", variants: [{ price: "2.450", available: true, option1: "NESCAFE" }] },
      ],
    });
  }
  if (url.includes("1D2IEWLQAD-dsn.algolia.net")) {
    return jsonResponse({
      hits: [
        {
          master_id: 58784,
          full_name_en: "Nescafe Classic Coffee 200g",
          price: 2.3,
          original_price: 2.3,
          on_sale: false,
          url_en: "/en/products/nescafe-classic-coffee-200g",
        },
      ],
    });
  }
  if (url.includes("-dsn.algolia.net")) {
    return jsonResponse({ hits: [{ itmn: "Nescafe Classic Coffee", objectID: "7001", clprc: 2.1, avaqt: 6 }] });
  }
  if (url.includes("eureka.com.kw")) {
    return htmlResponse('<input id="cky" value="A1B2C3D4"><input id="srcapk" value="keyA1b2c3">');
  }
  if (url.includes("sultan-center.com")) {
    return jsonResponse({
      products: { product_list: [{ name: "Nescafe Classic Coffee 50g", slug: "nescafe-classic", price: "2.400", is_in_stock: "1" }] },
    });
  }
  if (url.includes("jarir.com")) {
    return htmlResponse('x searchProviderKeys "key_test123456" y');
  }
  if (url.includes("cnstrc.com")) {
    return jsonResponse({
      response: { results: [{ data: { url: "p/nescafe-classic", price: "2.30", metadata: { name: "Nescafe Classic Coffee" } } }] },
    });
  }
  if (url.includes("amazon.eg")) {
    return htmlResponse(
      '<div data-component-type="s-search-result"><a href="https://www.amazon.eg/dp/B0NESCAFE1">link</a>' +
        '<span class="a-offscreen">2.60</span><h2 aria-label="Nescafe Classic Coffee"></h2></div>',
    );
  }
  if (url.includes("nextstore.com.kw")) {
    return htmlResponse(
      '<li><a class="product-item-link" href="https://www.nextstore.com.kw/nescafe-classic-coffee-50g.html" title="Nescafe Classic Coffee 50g">Nescafe Classic Coffee 50g</a>' +
        '<span class="price-box"><span class="price" data-price-amount="2.250" data-price-type="finalPrice">KD 2.250</span></span>' +
        '<a class="product-item-brand" href="/nescafe">NESCAFE</a></li>',
    );
  }
  if (url.includes("pckuwait.com")) {
    return htmlResponse(
      '<li class="product-type-simple"><a href="https://pckuwait.com/shop/nescafe-classic-coffee/" class="woocommerce-loop-product__link">' +
        '<h2 class="woocommerce-loop-product__title">Nescafe Classic Coffee 50g</h2></a>' +
        '<span class="price"><ins><span class="woocommerce-Price-amount amount">' +
        '<span class="woocommerce-Price-currencySymbol">KD</span>&nbsp;2.200</span></ins></span></li>',
    );
  }
  if (url.includes("luluhypermarket.com")) {
    const ld = JSON.stringify({
      "@type": "Product",
      name: "Nescafe Classic Coffee 50g",
      offers: {
        "@type": "Offer",
        price: "2.05",
        priceCurrency: "KWD",
        availability: "https://schema.org/InStock",
        url: "/en/nescafe-classic-coffee-50g",
      },
    });
    return htmlResponse(`<script type="application/ld+json">${ld}</script>`);
  }
  if (url.includes("myaster.com")) {
    return htmlResponse(
      '<script>{"sku":"1068110","name":"Nescafe Classic Coffee 200g","brand":"NESCAFE","quantity":3,' +
        '"inStock":true,"productUrl":"/p/nescafe-classic-coffee/1068110","itemLabels":["NONRX"],' +
        '"currency":"KWD","price":2.9,"special_price":2.15}</script>',
    );
  }
  if (url.includes("nahdionline.com")) {
    return htmlResponse(
      '<script>{"name":"Nescafe Classic Coffee 200g","price":{"KWD":{"default":2.3,' +
        '"default_formated":"2.30 KD","default_original_formated":"2.80 KD"}},"sku":"103830664"}</script>',
    );
  }
  if (url.includes("ounass.com")) {
    return htmlResponse(
      '<script>{"contentTypeId":"shelf","name":"Nescafe Classic Coffee 200g","price":2.4,' +
        '"categoryUrl":"women/gifts","analyticsId":"x1"}</script>',
    );
  }
  if (url.includes("algolia.net")) {
    return jsonResponse({
      hits: [
        {
          master_id: 58784,
          full_name_en: "Nescafe Classic Coffee 200g",
          price: 2.3,
          original_price: 2.3,
          on_sale: false,
          url_en: "/en/products/nescafe-classic-coffee-200g",
        },
      ],
    });
  }
  if (url.includes("alghanim-store.com")) {
    // Electro-theme archive card: empty symbol span inside the nested
    // sar-currency-symbol wrapper, `<del>` list price, `<ins>` sale price.
    return htmlResponse(
      '<h2 class="woocommerce-loop-product__title"><a class="woocommerce-loop-product__link" ' +
        'href="https://alghanim-store.com/product/nescafe-classic-coffee-50g/">Nescafe Classic Coffee 50g</a></h2>' +
        '<span class="price"><del><span class="woocommerce-Price-amount amount"><bdi>' +
        '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 2.80</bdi></span></del>' +
        '<ins><span class="woocommerce-Price-amount amount"><bdi>' +
        '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 2.40</bdi></span></ins></span>',
    );
  }
  if (url.includes("binsina.ae")) {
    // Magento Cloud search view: JSON-LD ItemList with relative offer urls.
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "Item",
          item: {
            "@type": "Product",
            name: "Nescafe Classic Coffee 50g",
            offers: {
              "@type": "Offer",
              price: "1.95",
              priceCurrency: "AED",
              availability: "https://schema.org/InStock",
              url: "/en/nescafe-classic-coffee-50g",
            },
          },
        },
      ],
    });
    return htmlResponse(`<script type="application/ld+json">${ld}</script>`);
  }
  return jsonResponse({});
};

describe("REEA-262 staged adapter dispatch", () => {
  it("settles a note with live hits for every retailer in the fan-out", async () => {
    resetDiscoveryCache();
    const staged = collectLiveResultsStaged("nescafe coffee", { fetchImpl });
    const snap = await staged.final;

    // Every adapter of the nineteen-store set (REA-270 batch, the
    // REEA-378 batch three and the REEA-557 first wave included) must
    // appear in the converged notes.
    expect(new Set(snap.notes.map((n) => n.merchant))).toEqual(
      new Set([
        "Xcite",
        "Blink",
        "Aster Pharmacy",
        "Eureka",
        "Sultan Center",
        "Jarir",
        "Amazon.eg",
        "Quadra Stores",
        "Next Store",
        "PC Kuwait",
        "Lulu Hypermarket",
        "Switch",
        "Wibi",
        "Astore",
        "Zayoom",
        "Yousifi",
        "Aster Pharmacy",
        "Nahdi",
        "Ounass",
        "Danube Home",
        "Alghanim Electronics",
        "BinSina",
      ]),
    );

    // Scheduled-and-silent would look identical for the new stores: each
    // one must also have answered with parsed hits and no error note.
    for (const merchant of [
      "Quadra Stores",
      "Next Store",
      "PC Kuwait",
      "Lulu Hypermarket",
      "Aster Pharmacy",
      "Nahdi",
      "Ounass",
      "Danube Home",
      "Alghanim Electronics",
      "BinSina",
    ]) {
      const note = snap.notes.find((n) => n.merchant === merchant);
      expect(note?.hits, `${merchant} must contribute hits`).toBeGreaterThan(0);
      expect(note?.error).toBeUndefined();
    }

    // The offers themselves ride the merged cards (price + availability).
    const card = snap.products[0];
    const merchants = card.offers.map((o) => o.merchant);
    expect(merchants).toEqual(expect.arrayContaining(["Quadra Stores", "Next Store", "PC Kuwait", "Lulu Hypermarket"]));
    expect(card.offers.every((o) => o.price > 0)).toBe(true);
  });
});
