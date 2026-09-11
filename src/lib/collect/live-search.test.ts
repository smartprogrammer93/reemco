/**
 * REEA-114 — live query-time collection tests: hit extraction per retailer
 * contract, cross-retailer grouping, and the bounded fan-out with injected
 * fetch (one failing retailer must not lose the others' offers).
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { PER_RETAILER_TIMEOUT_MS } from "@/lib/collect/types";
import { COVERAGE_ORDER } from "@/lib/collect/coverage";
import {
  asterHits,
  astoreHits,
  amazonEgHits,
  blinkHits,
  COLLECTORS,
  collectLiveResults,
  collectLiveResultsStaged,
  coverageLine,
  danubeHomeHits,
  followUpSnapshot,
  RESULTS_COMPLETION_BUDGET_MS,
  eurekaHits,
  groupHits,
  jarirHits,
  luluHits,
  nahdiHits,
  LIVE_SEARCH_BUDGET_MS,
  LIVE_SEARCH_HITS_PER_PAGE,
  LIVE_SEARCH_TIMEOUT_MS,
  PCK_BARE_HEDGE_MS,
  nextStoreHits,
  ounassHits,
  pcKuwaitApiHits,
  pcKuwaitHits,
  quadraHits,
  resetDiscoveryCache,
  sultanCenterHits,
  switchHits,
  wibiHits,
  widerQuery,
  xciteHits,
  yousifiHits,
  zayoomHits,
  type SearchHit,
} from "@/lib/collect/live-search";
import {
  canonicalFields,
  canonicalKey,
  compatibleFields,
  gradeBadgeLabel,
} from "@/lib/collect/canonical-product";
import { isAccessoryTitle, partitionForQuery } from "@/lib/relevance";
import { bestBadgeIndex } from "@/lib/stock";
import { toKwdNumeric } from "@/lib/format";
import { createQueryCache } from "@/lib/query-cache";

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

  it("blinkHits reads the suggest.json envelope the live hop answers (REEA-272)", () => {
    // Live shape (blink.com.kw/search/suggest.json, captured 2026-09-08):
    // products nest under resources.results and price/availability sit on
    // the product itself — the fold must feed them into the same hit chain,
    // which is what turned blink's deployed hits from 0 into real listings.
    const hits = blinkHits(
      {
        resources: {
          results: {
            products: [
              { title: "Samsung Galaxy S26+, 12GB", handle: "galaxy-s26-plus", available: true, price: "299.000", vendor: "Samsung" },
            ],
          },
        },
      },
      "samsung",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ merchant: "Blink", price: 299, brand: "Samsung", url: "https://blink.com.kw/products/galaxy-s26-plus", inStock: true });
  });

  it("quadraHits follows blink's Shopify contract with option1-brand precedence (REEA-238)", () => {
    // Live shape (quadrastores.com/products.json, captured 2026-09-08):
    // variant option1 carries the manufacturer, vendor the store's own name.
    const hits = quadraHits(
      {
        products: [
          {
            title: "ASUS VivoBook 15 X1502ZA Intel Core i5",
            handle: "asus-vivobook-15-x1502za",
            vendor: "Quadra Stores",
            variants: [{ price: "99.00", compare_at_price: "129.00", available: true, option1: "ASUS" }],
          },
          { title: "No Variant", handle: "nv", variants: [] },
        ],
      },
      "asus vivobook",
    );
    expect(hits[0]).toMatchObject({
      merchant: "Quadra Stores",
      brand: "ASUS",
      price: 99,
      wasPrice: 129,
      currency: "KWD",
      url: "https://quadrastores.com/products/asus-vivobook-15-x1502za",
      inStock: true,
    });
    expect(hits).toHaveLength(1);
  });

  it("Quadra cards correct a stale manufacturer stamp against the title brand (REEA-487)", () => {
    // Observed live on `iPhone 17 Pro`: the Huntsman Mini keyboard and the
    // Arctis Nova Pro headset both carried the option1 value ACER — Quadra's
    // Shopify `Manufacturer` option stamps one stale value over an import
    // batch. The adapter keeps the source field verbatim; the render chain
    // resolves the disagreement in favour of the brand the title shows.
    const hits = quadraHits(
      {
        products: [
          {
            title: "RAZER HUNTSMAN V3 PRO MINI 60% Analog Optical Esports Keyboard US - Black",
            handle: "razer-huntsman-v3-pro-mini-60-analog-optical-esports-keyboard-us-black-1",
            vendor: "Quadra Stores",
            variants: [{ price: "47.281", available: true, option1: "ACER" }],
          },
        ],
      },
      "razer huntsman v3 pro mini",
    );
    expect(hits[0].brand).toBe("ACER");
    const products = groupHits("razer huntsman v3 pro mini", hits);
    expect(products[0].brand).toBe("Razer");
  });

  it("quadraHits reads the suggest.json lite envelope with empty variants (REEA-408)", () => {
    // Live shape (quadrastores.com/search/suggest.json, captured 2026-09-09
    // from the coder edge): suggest records arrive with an EMPTY `variants`
    // array and carry price/availability on the product record — the fold in
    // normalizeShopifyProducts must keep those rows alive so the hop answers
    // its priced catalog instead of a standing zero.
    const hits = quadraHits(
      {
        resources: {
          results: {
            products: [
              {
                title: "DELL S2419HGF - 24 Inch Gaming Monitor - Black",
                handle: "dell-s2419hgf",
                vendor: "Dell",
                price: "89.000",
                available: true,
                compare_at_price_min: "119.000",
                variants: [],
                image: { src: "https://quadrastores.com/cdn/s2419hg.png" },
              },
              { title: "Label Only", handle: "lo", variants: [] },
            ],
          },
        },
      },
      "dell monitor",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Quadra Stores",
      brand: "Dell",
      price: 89,
      wasPrice: 119,
      currency: "KWD",
      url: "https://quadrastores.com/products/dell-s2419hgf",
      inStock: true,
    });
  });

  it("nextStoreHits scans Magento SSR cards through the shared scanner (REEA-238)", () => {
    // Trimmed from the captured live catalogsearch page (2026-09-08): card
    // anchor with title attr, price-box data-price amounts, brand anchor.
    const html =
      '<li><a class="product-item-link" href="https://www.nextstore.com.kw/lg-washing-machine-fh2j3qdnl02.html" title="LG Front Load Washing Machine FH2J3QDNL02">LG Front Load Washing Machine FH2J3QDNL02</a>' +
      '<span class="price-box"><span class="price" data-price-amount="119.900" data-price-type="finalPrice">KD 119.900</span>' +
      '<span class="old-price" data-price-amount="149.900" data-price-type="oldPrice">KD 149.900</span></span>' +
      '<a class="product-item-brand" href="/lg">LG</a></li>' +
      '<li><a class="product-item-link" href="https://www.nextstore.com.kw/anker-powercore.html" title="Anker PowerCore 20100">Anker PowerCore 20100</a>' +
      '<span class="price-box"><span class="price" data-price-amount="19.000" data-price-type="finalPrice">KD 19.000</span></span></li>';
    const hits = nextStoreHits(html, "lg washing machine");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Next Store",
      brand: "LG",
      price: 119.9,
      wasPrice: 149.9,
      currency: "KWD",
      url: "https://www.nextstore.com.kw/lg-washing-machine-fh2j3qdnl02.html",
      inStock: true,
    });
  });

  it("nextStoreHits marks only the explicit out-of-stock tail as unavailable", () => {
    const html =
      '<a class="product-item-link" href="https://www.nextstore.com.kw/lg-wm.html" title="LG Washing Machine F550">LG Washing Machine F550</a>' +
      '<span class="price-box"><span class="price" data-price-amount="89.000" data-price-type="finalPrice">KD 89.000</span></span>' +
      '<div class="stock unavailable">Out of stock</div>';
    const hits = nextStoreHits(html, "lg washing machine");
    expect(hits[0].inStock).toBe(false);
  });

  it("pcKuwaitHits reads WooCommerce sale prices off the product archive (REEA-238)", () => {
    // Trimmed from the captured live archive (2026-09-08): loop link wraps the
    // h2 title, price block keeps ins(current)/del(regular) with KD symbols.
    const html =
      '<li class="product-type-simple"><a href="https://pckuwait.com/shop/logitech-m330-silent-plus/" class="woocommerce-loop-product__link"><img alt="Logitech M330" />' +
      '<h2 class="woocommerce-loop-product__title">Logitech M330 Silent Plus Mouse</h2></a>' +
      '<span class="price"><ins><span class="woocommerce-Price-amount amount"><span class="woocommerce-Price-currencySymbol">KD</span>&nbsp;11.500</span></ins>' +
      '<del><span class="woocommerce-Price-amount amount"><span class="woocommerce-Price-currencySymbol">KD</span>&nbsp;13.000</span></del></span></li>';
    const hits = pcKuwaitHits(html, "logitech mouse");
    expect(hits[0]).toMatchObject({
      merchant: "PC Kuwait",
      title: "Logitech M330 Silent Plus Mouse",
      price: 11.5,
      wasPrice: 13,
      currency: "KWD",
      url: "https://pckuwait.com/shop/logitech-m330-silent-plus/",
      inStock: true,
    });
  });

  it("pcKuwaitApiHits reads Store API JSON with minor-unit prices (REEA-272)", () => {
    // Trimmed from the captured `/wp-json/wc/store/v1/products` payload
    // (2026-09-08): prices are minor-unit strings, KD uses three decimals.
    const payload = [
      {
        name: "Logitech M330 Silent Plus Mouse",
        permalink: "https://pckuwait.com/product/logitech-m330-silent-plus/",
        is_in_stock: true,
        images: [{ src: "https://pckuwait.com/wp-content/uploads/m330.jpg" }],
        prices: {
          price: "11500",
          regular_price: "13000",
          currency_code: "KWD",
          currency_minor_unit: 3,
        },
      },
      { name: "No Price Keyboard", prices: {} },
    ];
    const hits = pcKuwaitApiHits(payload, "logitech mouse");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "PC Kuwait",
      title: "Logitech M330 Silent Plus Mouse",
      price: 11.5,
      wasPrice: 13,
      currency: "KWD",
      url: "https://pckuwait.com/product/logitech-m330-silent-plus/",
      image: "https://pckuwait.com/wp-content/uploads/m330.jpg",
      inStock: true,
    });
  });

  it("PC Kuwait hop re-searches per word when the whole-query search is empty (REEA-357)", async () => {
    resetDiscoveryCache();
    // Live-measured Store API behaviour (2026-09-09): the near-exact phrase
    // match answers `dell laptop` with an empty array while `dell` answers 23
    // items — the hop must still surface hits for natural multi-word queries.
    const pckuwait = (q: string) => {
      if (q === "dell") {
        return [
          {
            name: "Dell KM7321W Pro Plus Keyboard Wireless Combo",
            permalink: "https://pckuwait.com/product/dell-km7321w/",
            is_in_stock: true,
            prices: { price: "29900", currency_code: "KWD", currency_minor_unit: 3 },
          },
        ];
      }
      if (q === "laptop") {
        return [
          {
            name: "Dell KM7321W Pro Plus Keyboard Wireless Combo",
            permalink: "https://pckuwait.com/product/dell-km7321w/",
            is_in_stock: true,
            prices: { price: "29900", currency_code: "KWD", currency_minor_unit: 3 },
          },
          {
            name: "Asus Vivobook 15 Laptop Core i5",
            permalink: "https://pckuwait.com/product/asus-vivobook-15/",
            is_in_stock: true,
            prices: { price: "119000", currency_code: "KWD", currency_minor_unit: 3 },
          },
        ];
      }
      return [];
    };
    const { notes } = await collectLiveResults("dell laptop", {
      fetchImpl: async (url) => {
        if (url.includes("wp-json/wc/store/v1/products")) {
          const q = decodeURIComponent(url.match(/[?&]search=([^&]*)/)?.[1] ?? "");
          return new Response(JSON.stringify(pckuwait(q)), { headers: { "content-type": "application/json" } });
        }
        return new Response("{}");
      },
    });
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    // The shared combo card merges to one entry: keyboard + laptop = 2 hits,
    // and the note carries no error field.
    expect(note?.hits).toBe(2);
    expect(note?.error).toBeUndefined();
    // REEA-488 item 2: every stage note carries its coupon coverage count —
    // this hop's contract surfaced no coupon info, and the note says so with
    // an honest 0 beside the hit count instead of staying silent.
    expect(note?.coupons).toBe(0);
  });

  it("PC Kuwait hop stops at the first non-empty whole-query answer (REEA-357)", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    await collectLiveResults("iphone", {
      fetchImpl: async (url) => {
        if (url.includes("wp-json/wc/store/v1/products")) {
          calls.push(url);
          return new Response(
            JSON.stringify([
              {
                name: "Apple iPhone 15 128GB",
                permalink: "https://pckuwait.com/product/iphone-15/",
                is_in_stock: true,
                prices: { price: "185000", currency_code: "KWD", currency_minor_unit: 3 },
              },
            ]),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}");
      },
    });
    // Phrase hit answers the hop: exactly one Store API search, no per-word
    // follow-ups, so the common path stays as cheap as before the fix.
    expect(calls).toHaveLength(1);
  });

  it("PC Kuwait Arabic probe re-searches the curated Latin forms (REEA-416)", async () => {
    resetDiscoveryCache();
    // Measured live: the Store API answers `keyboard` with priced rows while
    // every Arabic spelling (phrase or single token) returns a bare []. The
    // curated Latin forms lead the SAME bounded re-search set; the shared
    // gate still scores rows against the ORIGINAL Arabic query through the
    // alias bridge (كيبورد → keyboard).
    const seenQ: string[] = [];
    const { notes } = await collectLiveResults("كيبورد", {
      fetchImpl: async (url) => {
        if (url.includes("wp-json/wc/store/v1/products")) {
          const q = decodeURIComponent(url.match(/[?&]search=([^&]*)/)?.[1] ?? "");
          seenQ.push(q);
          const rows =
            q === "keyboard"
              ? [
                  {
                    name: "Keychron Q16 HE Mechanical Keyboard",
                    permalink: "https://pckuwait.com/product/q16-he/",
                    is_in_stock: true,
                    prices: { price: "64000", currency_code: "KWD", currency_minor_unit: 3 },
                  },
                ]
              : [];
          return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
        }
        return new Response("{}");
      },
    });
    expect(seenQ).toContain("keyboard");
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    expect((note?.hits ?? 0)).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  });

  it("PC Kuwait hop leads with the bare GET and rides the KV replay second (REEA-526)", async () => {
    resetDiscoveryCache();
    // Measured on the deployed path: the bare accept-only GET answers the
    // Store API in well under a second while the completion-budget note
    // stood on every fetch — the replay-led chain burned the finalize
    // window before the network answer landed. The attempt ORDER is the
    // fix: bare first, cache replay second, handshake last. This mock blips
    // the bare attempt once (503) so the replay behind it answers; the
    // recorded shape per attempt asserts the order.
    const attempts: { cache: string; headerKeys: string }[] = [];
    const { notes } = await collectLiveResults("iphone", {
      fetchImpl: async (url, init) => {
        if (url.includes("wp-json/wc/store/v1/products")) {
          attempts.push({
            cache: String((init as { cache?: string } | undefined)?.cache ?? ""),
            headerKeys: Object.keys((init?.headers as Record<string, string>) ?? {}).join(","),
          });
          const rows = [
            {
              name: "Apple iPhone 15 128GB",
              permalink: "https://pckuwait.com/product/iphone-15/",
              is_in_stock: true,
              prices: { price: "185000", currency_code: "KWD", currency_minor_unit: 3 },
            },
          ];
          // First attempt blips, the ride-along replay answers.
          if (attempts.length === 1) return new Response("[]", { status: 503 });
          return new Response(JSON.stringify(rows), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}");
      },
    });
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    // Lead attempt: bare accept-only identity, uncached.
    expect(attempts[0].headerKeys).toBe("accept");
    expect(attempts[0].cache).toBe("no-store");
    // Second attempt: the KV replay with the crawler identity.
    expect(attempts[1].cache).toBe("force-cache");
    expect(attempts[1].headerKeys.length).toBeGreaterThan("accept".length);
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    expect(note?.hits).toBe(1);
    expect(note?.error).toBeUndefined();
  });

  it("PC Kuwait hop rides the KV replay concurrently when the bare GET is silent past the hedge slice (REEA-550)", async () => {
    resetDiscoveryCache();
    // Measured on the deployed stamp: on cold instances the bare accept-only
    // GET spends the whole finalize window on TLS + WP setup before it
    // answers, so every round closed with a budget note while the endpoint
    // itself answered fine from a warm line. The hedge: while bare is STILL
    // pending past PCK_BARE_HEDGE_MS, the KV replay starts alongside it and
    // whichever shape answers first wins. Here bare is deliberately slower
    // than the slice, the replay answers immediately — and must start BEFORE
    // bare has answered, not after.
    let bareDone = false;
    let replaySawBarePending: boolean | undefined;
    const attempts: string[] = [];
    const { notes } = await collectLiveResults("iphone", {
      fetchImpl: async (url, init) => {
        if (!url.includes("wp-json/wc/store/v1/products")) return new Response("{}");
        const cache = String((init as { cache?: string } | undefined)?.cache ?? "");
        attempts.push(cache);
        if (cache === "no-store") {
          // Bare leads but only answers after the hedge slice has fired.
          await new Promise((r) => setTimeout(r, PCK_BARE_HEDGE_MS + 150));
          bareDone = true;
        } else {
          replaySawBarePending = !bareDone;
        }
        const rows = [
          {
            name: "Apple iPhone 15 128GB",
            permalink: "https://pckuwait.com/product/iphone-15/",
            is_in_stock: true,
            prices: { price: "185000", currency_code: "KWD", currency_minor_unit: 3 },
          },
        ];
        return new Response(JSON.stringify(rows), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    // Bare led alone first, the replay only joined once the slice expired —
    // and it joined WHILE bare was still in flight, not after.
    expect(attempts.slice(0, 2)).toEqual(["no-store", "force-cache"]);
    expect(replaySawBarePending).toBe(true);
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    expect(note?.hits).toBe(1);
    expect(note?.error).toBeUndefined();
  });

  it("PC Kuwait hop falls through to the archive page when the Store API answers an HTML shell (REEA-432)", async () => {
    resetDiscoveryCache();
    // Measured on the deployed stamp: this CF-fronted zone sometimes answers
    // the JSON Store endpoint with its interstitial HTML shell (HTTP-ok, not
    // JSON). A malformed body is NOT an answer — the hop-global flag must
    // stay unset so the designed archive HTML hop still runs and the
    // merchant keeps hits instead of recording hits:0 every round.
    const storeCalls: string[] = [];
    const archiveCalls: string[] = [];
    const { notes } = await collectLiveResults("iphone", {
      fetchImpl: async (url) => {
        if (url.includes("/wp-json/wc/store/v1/products")) {
          storeCalls.push(url);
          // The realistic production shape of the blip: a CF-interstitial
          // HTML body with an ok status on the JSON endpoint.
          return new Response(
            '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-error-details">Just a moment...</div></body></html>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (url.includes("post_type=product")) {
          archiveCalls.push(url);
          // The archive hop answers with live WooCommerce loop cards.
          return new Response(
            '<li class="product-type-simple"><a href="https://pckuwait.com/shop/apple-iphone-15/" class="woocommerce-loop-product__link"><img alt="Apple iPhone 15" />' +
              '<h2 class="woocommerce-loop-product__title">Apple iPhone 15 128GB</h2></a>' +
              '<span class="price"><span class="woocommerce-Price-amount amount"><span class="woocommerce-Price-currencySymbol">KD</span>&nbsp;325.000</span></span></li>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("{}");
      },
    });
    // The JSON attempts were made (live-at-query-time kept), and the archive
    // hop ran for the ORIGINAL phrase against the WooCommerce search view.
    expect(storeCalls.length).toBeGreaterThan(0);
    expect(archiveCalls.length).toBeGreaterThan(0);
    expect(archiveCalls[0]).toContain("s=iphone");
    expect(archiveCalls[0]).toContain("post_type=product");
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    // The archive-sourced cards land despite the malformed JSON answer —
    // hits > 0 with the archive title through the shared relevance gate.
    expect((note?.hits ?? 0)).toBeGreaterThan(0);
    expect(note?.error).toBeUndefined();
  });

  it("Quadra hop tops up the over-narrow suggest envelope from the newest page (REEA-526)", async () => {
    resetDiscoveryCache();
    // Measured live 2026-09-10: this zone's suggest answers `iPhone 17 Pro`
    // with a bare empty resources array while the phrase-titled rows sit in
    // the plain products.json feed. The shared Shopify pair hop (suggest +
    // newest-page top-up, one window) refills the shelf; the gate scores
    // every merged row against the ORIGINAL phrase.
    const seenUrls: string[] = [];
    const { notes } = await collectLiveResults("iPhone 17 Pro", {
      fetchImpl: async (url) => {
        seenUrls.push(url);
        if (url.includes("suggest.json")) {
          return new Response(JSON.stringify({ resources: { results: { products: [] } } }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("products.json")) {
          return new Response(
            JSON.stringify({
              products: [
                {
                  title: "APPLE iPhone 17 Pro Max 256GB Smartphone",
                  handle: "iphone-17-pro-max-256",
                  vendor: "Apple",
                  variants: [{ price: "459.000", option1: "Apple", available: true }],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}");
      },
    });
    expect(seenUrls.some((u) => u.includes("suggest.json"))).toBe(true);
    expect(seenUrls.some((u) => u.includes("products.json"))).toBe(true);
    const quadra = notes.find((n) => n.merchant === "Quadra Stores");
    expect(quadra?.hits ?? 0).toBeGreaterThanOrEqual(1);
    expect(quadra?.error).toBeUndefined();
  });

  it("Blink Arabic probe re-searches the curated Latin forms on the suggest hop (REEA-416)", async () => {
    resetDiscoveryCache();
    // Measured live: suggest.json answers `دوف` with a thin fuzzy set and the
    // Arabic phrase with a bare envelope, while `dove`/`soap` answer priced
    // rows — the curated Latin forms lead the bounded re-search and the
    // shared gate scores the merged rows against the original Arabic query.
    const seenQ: string[] = [];
    const { notes } = await collectLiveResults("\u062f\u0648\u0641 \u0635\u0627\u0628\u0648\u0646", {
      fetchImpl: async (url) => {
        if (url.includes("blink.com.kw/search/suggest.json")) {
          const q = decodeURIComponent(url.match(/[?&]q=([^&]*)/)?.[1] ?? "");
          seenQ.push(q);
          const rows =
            q === "dove" || q === "soap"
              ? [
                  {
                    title: "Dove Beauty Bar Soap",
                    handle: "dove-beauty-bar-soap",
                    price: "1.77",
                    variants: [{ price: "1.77", available: true }],
                  },
                ]
              : [];
          return new Response(JSON.stringify({ resources: { results: { products: rows } } }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}");
      },
    });
    expect(seenQ).toContain("dove");
    const note = notes.find((n) => n.merchant === "Blink");
    expect((note?.hits ?? 0)).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  });

  it("luluHits lifts JSON-LD offers and honours schema.org availability (REEA-238)", () => {
    // Shape captured from the luluhypermarket.com SSR search page 2026-09-08:
    // ItemList wrapper, relative offer URLs, explicit InStock/OutOfStock.
    const ld = JSON.stringify({
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "Item",
          item: {
            "@type": "Product",
            name: "Apple iPhone 15 128 GB Blue",
            offers: {
              "@type": "Offer",
              price: "249.00",
              priceCurrency: "KWD",
              availability: "https://schema.org/InStock",
              url: "/en/apple-iphone-15-128-gb",
            },
          },
        },
        {
          "@type": "Item",
          item: {
            "@type": "Product",
            name: "Apple iPhone 15 Plus 128 GB",
            offers: { "@type": "Offer", price: "299.00", priceCurrency: "KWD", availability: "https://schema.org/OutOfStock" },
          },
        },
      ],
    });
    const hits = luluHits(`<script type="application/ld+json">${ld}</script>`, "iphone 15");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ merchant: "Lulu Hypermarket", price: 249, currency: "KWD", inStock: true });
    expect(hits[0].url).toBe("https://www.luluhypermarket.com/en/apple-iphone-15-128-gb");
    expect(hits[1].inStock).toBe(false);
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

  it("jarirHits reads the metadata brand through the shared candidate chain (REEA-195)", () => {
    // Adapter symmetry: jarir is the only JSON contract that nests `brand`
    // inside metadata — the Arabic index ships it populated and the card's
    // brand line must not go blank for that reason.
    const hits = jarirHits(
      { response: { results: [{ data: { url: "p/ap-airpods4", price: 59, metadata: { name: "سماعة أبل AirPod Slic 4 Generate", brand: "Apple" } } }] } },
      "سماعة أبل",
    );
    expect(hits[0]).toMatchObject({ brand: "Apple", title: "سماعة أبل AirPod Slic 4 Generate" });
  });

  it("Arabic brand queries survive the English-index coverage gates (REEA-195)", () => {
    // Observed live: xcite's en index answers the Arabic query with Latin
    // titles. Plain cross-script substring coverage drops every one of them,
    // leaving only Jarir's Arabic listings — the QA-reported generic-speaker
    // result. The alias bridge keeps the branded hit and still cuts noise.
    const hits = xciteHits(
      {
        results: [
          {
            hits: [
              { name: "Apple Airpods 4 - White", slug: "apple-airpods-4-white", price: 34.9, currency: "KWD", inStock: true },
              { name: "Anker PowerCore 20100 mAh", slug: "anker-powercore", price: 15, currency: "KWD", inStock: true },
            ],
          },
        ],
      },
      "سماعة أبل",
    );
    expect(hits.map((h) => h.title)).toEqual(["Apple Airpods 4 - White"]);
  });

  it("Arabic brand queries lead with the branded offers (REEA-195)", () => {
    // Same-script filler out-scores the branded device in the symmetric fit
    // score; the brand-match partition moves the Apple offer in front while
    // everything keeps its relative order behind it. One merchant on both
    // rows keeps the retailer round-robin out of the ordering question.
    const hits: SearchHit[] = [
      { title: "سماعة القرآن الكريم للاطفال", merchant: "Jarir", country: "SA", price: 299, currency: "SAR", url: "https://www.jarir.com/arabic-books-675545.html", inStock: true },
      { title: "Apple Airpods 4 - White", merchant: "Jarir", country: "SA", brand: "Apple", price: 34.9, currency: "SAR", url: "https://www.jarir.com/p/ap-airpods4", inStock: true },
    ];
    const products = groupHits("سماعة أبل", hits);
    expect(products[0].title).toBe("Apple Airpods 4 - White");
    expect(products[0].brand).toBe("Apple");
    expect(products[1].title).toBe("سماعة القرآن الكريم للاطفال");
  });

  it("jarirHits keeps verbose live index titles on one-word brand queries (REEA-137)", () => {
    // Fixture trimmed from the real Constructor answer for "samsung": every
    // genuine hit carries a spec tail. Under the old symmetric title score
    // those titles fell below MIN_SCORE and the retailer silently vanished
    // from samsung results.
    const hits = jarirHits(
      {
        response: {
          results: [
            { data: { url: "samsung-galaxy-s25-ultra-256-titanium-black.html", price: 4399, metadata: { name: "Samsung Galaxy S25 Ultra, 256 GB, 12 GB RAM, Titanium Black, 5G, Snapdragon 8 Elite" } } },
            { data: { url: "anker-powercore.html", price: 10, metadata: { name: "Anker PowerCore 20100" } } },
          ],
        },
      },
      "samsung",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].merchant).toBe("Jarir");
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

  it("sultanCenterHits keeps English-titled grocery rows for the Arabic fixed-set query (REEA-408)", () => {
    // Fixture trimmed from the live mobile/api/search answer for
    // `أرز بسمتي` captured 2026-09-09: the zone lists its basmati stock
    // under English titles, so a cross-script zero-score drop here is the
    // silent-zero cell the deployed matrix recorded — with the curated
    // category forms the rows score on their own words and survive.
    const payload = {
      status: "1",
      products: {
        product_list: [
          { name: "Country Xl Organic Basmati Rice", sku: "1", price: "2.3100", slug: "country-xl-organic-basmati-rice-2-kg-1", is_in_stock: "1" },
          { name: "Daawat Extra Long White Basmati Rice", sku: "2", price: "1.8500", slug: "daawat-extra-long-white-basmati-rice", is_in_stock: "1" },
        ],
      },
    };
    const hits = sultanCenterHits(payload, "أرز بسمتي");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toMatch(/Basmati Rice/);
  });

  it("brand+category Arabic queries keep the matching row and drop near-miss rows", () => {
    // `لابتوب ديل` on the Store API shape: the laptop row answers both the
    // curated category form and (via the brand alias) the brand token; the
    // tea row answers neither and the gate holds it out.
    const hits = pcKuwaitApiHits(
      [
        { name: 'Latitude 5440 Laptop 14" i5', permalink: "https://pckuwait.com/lat-5440", prices: { price: "119000", regular_price: "125000", currency_minor_unit: "3", currency_code: "KWD" }, is_in_stock: true },
        { name: "Lipton Yellow Label Black Tea", permalink: "https://pckuwait.com/lipton", prices: { price: "450", currency_minor_unit: "3" }, is_in_stock: true },
      ],
      "لابتوب ديل",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Latitude 5440 Laptop 14" i5');
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
    country: "KW",
    ...over,
  };
}

describe("groupHits", () => {
  it("merges the same title across retailers, cheapest offer first", () => {
    const products = groupHits("samsung", [
      hit({ merchant: "Jarir", price: 410, url: "https://jarir.example/s26" }),
      hit({ merchant: "Amazon.eg", price: 390, url: "https://amz.example/dp/1", currency: "EGP", inStock: false }),
      hit({ merchant: "Xcite", price: 399 }),
      hit({ title: "Samsung Monitor Odyssey", merchant: "Blink", price: 200, url: "https://blink.example/2" }),
    ]);
    expect(products).toHaveLength(2);
    const s26 = products.find((p) => p.title === "Samsung Galaxy S26 Ultra")!;
    const monitor = products.find((p) => p.title === "Samsung Monitor Odyssey")!;
    // REEA-167 §2: the canonical offer list ascends by price — cheapest
    // first; purchasable offers only break ties.
    expect(s26.offers.map((o) => o.merchant)).toEqual(["Amazon.eg", "Xcite", "Jarir"]);
    // REEA-488 item 1: alternatives list CHEAPER same-family products. The
    // monitor (200 KWD) is not cheaper than the S26's best row (~20 KWD after
    // EGP conversion), so the phone card gets none; the monitor sees the
    // cheaper phone.
    expect(s26.alternatives).toHaveLength(0);
    expect(monitor.alternatives.map((a) => a.title)).toContain("Samsung Galaxy S26 Ultra");
    expect(monitor.offers).toHaveLength(1);
    // Real collection timestamp, not a computed offset — chips age honestly.
    expect(Date.parse(s26.scrapedAt!)).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - Date.parse(s26.scrapedAt!)).toBeLessThan(5_000);
  });

  it("REEA-168: one canonical view for two title spellings, union of offers, cheapest first", () => {
    const products = groupHits("galaxy z fold7 256gb silver", [
      hit({
        title: "Samsung Galaxy Z Fold7 Phone - Silver",
        merchant: "Xcite",
        price: 494.9,
        url: "https://xcite.example/fold7-phone",
      }),
      hit({
        title: "Samsung Galaxy Z Fold7 256GB 12GB Ram 5G Silver",
        merchant: "Xcite",
        price: 429.9,
        url: "https://xcite.example/fold7-256",
      }),
      hit({
        title: "Samsung Galaxy Z Fold7, 256 GB, 12 GB RAM, Silver Shadow, 5G, Snapdragon 8 Elite",
        merchant: "Jarir",
        price: 7699,
        currency: "SAR",
        url: "https://jarir.example/fold7",
      }),
    ]);
    // One canonical row, not split pages (REEA-167 acceptance 1/4): three
    // live listings of one device, one merged view.
    expect(products).toHaveLength(1);
    const fold = products[0];
    // REEA-192: one row per retailer at that retailer's best matched-product
    // offer — Xcite's two listings fold into its cheapest one.
    expect(fold.offers.map((o) => o.price)).toEqual([429.9, 7699]);
    expect(fold.offers.map((o) => o.merchant)).toEqual(["Xcite", "Jarir"]);
    // Canonical title = member title with the fewest tokens → stable slug.
    expect(fold.title).toBe("Samsung Galaxy Z Fold7 Phone - Silver");
    expect(fold.productId).toBe("samsung-galaxy-z-fold7-phone-silver");
  });

  it("REEA-280: retailer-titled and Apple-store-titled spellings of one SKU share a card", () => {
    // Mirrors the live q=iPad Air answers: Xcite writes the short spec line,
    // the Apple-store spelling adds "Tablet … Apple Intelligence …" tails —
    // both describe the same 128 GB Blue 11" M4 device and must land on one
    // card; the 64 GB Starlight listing is a different tier and stays out.
    const products = groupHits("ipad air 128gb", [
      hit({
        title: "Apple iPad Air 11 inch M4 2026 128GB 5G MH794AB/A Blue",
        merchant: "Xcite",
        price: 349,
        url: "https://xcite.example/ipad-air-128-5g",
      }),
      hit({
        title: 'Apple iPad Air 11 M4 Tablet - Wi-Fi 2026, Apple Intelligence, 11", 128 GB, Blue, 8-core CPU',
        merchant: "Jarir",
        price: 799,
        currency: "SAR",
        url: "https://jarir.example/ipad-air-128",
      }),
      hit({
        title: "Apple iPad Air (Wi-Fi, 64GB) - Starlight - 10.9in",
        merchant: "Eureka",
        price: 259,
        url: "https://eureka.example/ipad-air-64",
      }),
    ]);
    const cards = products.filter((p) => !isAccessoryTitle(p.title));
    expect(cards).toHaveLength(2);
    const shared = cards.find((p) => p.offers.length === 2)!;
    // Cheapest offer leads the merged card; both spellings ride inside it.
    // REEA-254 item B: the SAR figure wins on effective price — SAR 799 is
    // ≈KD 65.2 against the KWD 349 row, so the converted comparison leads
    // with it (raw numerics read the other way round).
    expect(shared.offers.map((o) => o.price)).toEqual([799, 349]);
    // The distinct storage tier keeps its own card.
    const solo = cards.find((p) => p.offers.length === 1)!;
    expect(solo.offers[0].merchant).toBe("Eureka");
  });

  it("REEA-192: fold7 live case — device card carries phone offers only, badge row cheapest phone offer, accessory cards own their rows", () => {
    // Mirrors the live q=fold7 answers: three phone listings across
    // Xcite/Eureka/Jarir plus accessory-class listings that previously folded
    // into the phone card and pushed the SAR 69 case price under the badge.
    const products = groupHits("fold7", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 429.9, url: "https://xcite.example/fold7-black" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone", merchant: "Eureka", price: 494.9, url: "https://eureka.example/fold7" }),
      hit({ title: "Samsung Galaxy Z Fold7 256GB 12GB Ram 5G Black", merchant: "Jarir", price: 7699, currency: "SAR", url: "https://jarir.example/fold7" }),
      hit({ title: "Araree Aero Flex Electronic Gadgets Cases For Samsung Galaxy Z Fold7", merchant: "Jarir", price: 69, currency: "SAR", url: "https://jarir.example/aero-case" }),
      hit({ title: "OtterBox Defender Series XT Cases For Samsung Galaxy Z Fold7", merchant: "Jarir", price: 99, currency: "SAR", url: "https://jarir.example/otter-case" }),
      hit({ title: "Panzerglass Screen Protector Film For Galaxy Z Fold7 PG68903", merchant: "Amazon.eg", price: 149, currency: "EGP", url: "https://amazon.example/dp/x1" }),
    ]);
    const device = products.find((p) => !isAccessoryTitle(p.title))!;
    // Phone-class offers only; one row per retailer at its best phone price;
    // cheapest phone offer first is what the LOWEST LISTED PRICE badge reads.
    expect(device.offers.map((o) => o.price)).toEqual([429.9, 494.9, 7699]);
    expect(device.offers.map((o) => o.merchant)).toEqual(["Xcite", "Eureka", "Jarir"]);
    // Accessory listings keep their own cards (REEA-180 Rule 2 tiering puts
    // them under the devices container); the case never dilutes the phone set.
    const accessories = products.filter((p) => isAccessoryTitle(p.title));
    expect(accessories.length).toBeGreaterThan(0);
    expect(accessories.every((p) => p.offers.every((o) => o.price < Math.min(...device.offers.map((x) => x.price))))).toBe(true);
  });

  it("REEA-192: Arabic accessory markers classify the same way (كفر / جراب)", () => {
    const products = groupHits("fold7", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 429.9, url: "https://xcite.example/fold7-black" }),
      hit({ title: "جراب سامسونج جلاكسي Z Fold7", merchant: "Jarir", price: 59, currency: "SAR", url: "https://jarir.example/jirab" }),
    ]);
    expect(products).toHaveLength(2);
    const device = products.find((p) => !isAccessoryTitle(p.title))!;
    const cover = products.find((p) => isAccessoryTitle(p.title))!;
    expect(device.offers.map((o) => o.price)).toEqual([429.9]);
    expect(cover.offers.map((o) => o.price)).toEqual([59]);
  });

  it("REEA-192: one row per retailer at its best matched-product offer", () => {
    const products = groupHits("fold7", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 429.9, url: "https://xcite.example/a" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Xcite", price: 460, url: "https://xcite.example/b" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Black", merchant: "Jarir", price: 455, currency: "SAR", url: "https://jarir.example/c" }),
    ]);
    expect(products).toHaveLength(1);
    // REEA-254 item B — Jarir's SAR 455 is ≈KD 37.1 against Xcite's KWD
    // 429.9, so the converted-best row leads the card.
    expect(products[0].offers.map((o) => `${o.merchant}:${o.price}`)).toEqual(["Jarir:455", "Xcite:429.9"]);
  });

  it("REEA-168: both example spellings reduce to one canonical key", () => {
    // Worked example from the spec (§1 step 4): brand|model_line|storage|
    // color|grade, joined with "|", fields in that exact order.
    expect(canonicalKey("Samsung Galaxy Z Fold7 Phone Silver Renewed Grade B")).toBe(
      "samsung|galaxy z fold7|silver|renewed-grade-b",
    );
    // Worked example from the spec (§1 step 4): the verbose retailer title
    // lands on the same tuple as the short one; RAM restatements are the
    // only noise stripped around it.
    expect(canonicalFields("Samsung Galaxy Z Fold7 Phone Silver")).toMatchObject({
      brand: "samsung",
      modelLine: "galaxy z fold7",
      color: "silver",
      grade: "new",
    });
    expect(canonicalFields("Samsung Galaxy Z Fold7, 256 GB, 12 GB RAM, Silver Shadow, 5G, Snapdragon 8 Elite")).toMatchObject({
      brand: "samsung",
      modelLine: "galaxy z fold7",
      storage: "256gb",
      color: "silver",
      grade: "new",
    });
    const a = canonicalFields("Samsung Galaxy Z Fold7 Phone Silver");
    const b = canonicalFields("Samsung Galaxy Z Fold7, 256 GB, 12 GB RAM, Silver Shadow, 5G, Snapdragon 8 Elite");
    expect(compatibleFields(a, b)).toBe(true); // partial-match rule (§1)
    // Both live example slugs decode to compatible field sets.
    expect(
      compatibleFields(
        canonicalFields("samsung galaxy z fold7 5g 256gb phone silver"),
        canonicalFields("samsung galaxy z fold7 256gb 12gb ram 5g silver"),
      ),
    ).toBe(true);
  });

  it("REEA-205: inch-quote noise collapses the iPhone live pair into one card", () => {
    // Live board pair for "iphone 17 pro max": Xcite quotes the inch sign,
    // Eureka spells it out and carries a network token — one device must
    // render ONE card, cheapest offer leading (the LOWEST LISTED PRICE row).
    const products = groupHits("iphone 17 pro max", [
      hit({ title: 'Apple iPhone 17 Pro Max 6.9" 256GB - Silver', merchant: "Xcite", price: 429.9, url: "https://xcite.example/17pm-silver" }),
      hit({ title: "Apple iPhone 17 Pro Max 6.9 inch 256GB 5G Silver", merchant: "Eureka", price: 379.9, url: "https://eureka.example/17pm" }),
    ]);
    expect(products).toHaveLength(1);
    expect(products[0].offers.map((o) => [o.merchant, o.price])).toEqual([
      ["Eureka", 379.9],
      ["Xcite", 429.9],
    ]);
  });

  it("REEA-205: quote marks fold like separators in every encoding flavour", () => {
    // Straight inch sign, right curly quote and the prime all tokenize to
    // the same size token as the spelled "inch".
    const spelled = canonicalKey("Apple iPhone 17 Pro Max 6.9 inch 256GB Silver");
    expect(canonicalKey('Apple iPhone 17 Pro Max 6.9" 256GB - Silver')).toBe(spelled);
    expect(canonicalKey("Apple iPhone 17 Pro Max 6.9\u201D 256GB Silver")).toBe(spelled);
    expect(canonicalKey("Apple iPhone 17 Pro Max 6.9\u2033 256GB Silver")).toBe(spelled);
    // Over-merge guard survives the folding: capacities stay separate cards.
    expect(
      compatibleFields(
        canonicalFields('Apple iPhone 17 Pro Max 6.9" 256GB - Silver'),
        canonicalFields("Apple iPhone 17 Pro Max 6.9 inch 512GB Silver"),
      ),
    ).toBe(false);
  });

  it("REEA-205: Arabic titles merge on separator noise, capacities discriminate", () => {
    // Arabic-script listings of the same device fold across comma/dash
    // noise; an Arabic-unit capacity ("جيجابايت") keeps discriminating, so
    // 512GB never rides the 256GB card.
    const products = groupHits("آيفون 17 برو ماكس", [
      hit({ title: "أبل آيفون 17 برو ماكس 256 جيجابايت فضي", merchant: "Jarir", price: 410, url: "https://jarir.example/ar1" }),
      hit({ title: "أبل آيفون 17 برو ماكس, 256 جيجابايت - فضي", merchant: "Xcite", price: 429.9, url: "https://xcite.example/ar2" }),
      hit({ title: "أبل آيفون 17 برو ماكس 512 جيجابايت فضي", merchant: "Eureka", price: 459.9, url: "https://eureka.example/ar3" }),
    ]);
    expect(products).toHaveLength(2);
    // Cheapest group leads with both 256GB listings inside it.
    expect(products[0].offers.map((o) => o.merchant)).toEqual(["Jarir", "Xcite"]);
    expect(products[1].offers).toHaveLength(1);
  });

  it("REEA-168: over-merge guards keep distinct variants separate (§3)", () => {
    const base = canonicalFields("Samsung Galaxy Z Fold7 Phone Silver");
    expect(compatibleFields(base, canonicalFields("Samsung Galaxy Z Fold7 Phone Gray"))).toBe(false); // color
    expect(compatibleFields(base, canonicalFields("Samsung Galaxy S25 Phone Silver"))).toBe(false); // model line
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Flip7 Phone Silver"),
      ),
    ).toBe(false); // fold ≠ flip
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Fold7 Phone Gray"),
      ),
    ).toBe(false); // gray ≠ silver
    const renewed = canonicalFields("Samsung Galaxy Z Fold7 Phone Silver Renewed Grade B");
    expect(compatibleFields(base, renewed)).toBe(false); // grade is significant
    expect(renewed.grade).toBe("renewed-grade-b");
    expect(gradeBadgeLabel(renewed.grade)).toBe("Renewed Grade B");
    // Storage restatements and RAM qualify: 512GB never joins the 256GB key;
    // a subset key (no colour yet) joins the matching group — never forks it.
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver 512 GB"),
      ),
    ).toBe(true); // subset (missing storage) merges
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver 256 GB"),
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver 512 GB"),
      ),
    ).toBe(false); // present fields must agree
    expect(compatibleFields(canonicalFields("Samsung Galaxy Z Fold7"), base)).toBe(true);
  });

  it("REEA-254: colours ride inside one model+storage card as best-price swatches", () => {
    // REEA-254 supersedes the REEA-169 per-colour card split: one card per
    // model+storage tier; colours become swatches carrying each colour's
    // best effective price when they differ. Colourless listings still join
    // through the partial-match rule.
    const products = groupHits("galaxy z fold7 silver", [
      hit({ title: "Samsung Galaxy Z Fold7 Phone", merchant: "Blink", price: 460, url: "https://blink.example/seed" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Silver", merchant: "Eureka", price: 494.9, url: "https://eureka.example/silver" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Silver", merchant: "Xcite", price: 429.9, url: "https://xcite.example/silver" }),
      hit({ title: "Samsung Galaxy Z Fold7 Phone Jet Black", merchant: "Jarir", price: 455, url: "https://jarir.example/black" }),
    ]);
    // Every listing of the tier lands on the ONE collapsed card.
    expect(products).toHaveLength(1);
    const fold = products[0];
    // Cheapest offer first; one row per retailer at its best price.
    expect(fold.offers.map((o) => `${o.merchant}:${o.price}`)).toEqual([
      "Xcite:429.9",
      "Jarir:455",
      "Blink:460",
      "Eureka:494.9",
    ]);
    // Canonical title: fewest tokens among members — the colourless seed.
    expect(fold.title).toBe("Samsung Galaxy Z Fold7 Phone");
    // Swatches: cheapest colour first; delta rides off the card's best.
    expect(fold.variations).toEqual([
      { id: "silver", label: "Silver", priceDelta: 0 },
      { id: "black", label: "Black", priceDelta: 25.1 },
    ]);
    // Jet Black collapses to base black without polluting the model line.
    expect(canonicalFields("Samsung Galaxy Z Fold7 Phone Jet Black").modelLine).toBe("galaxy z fold7");    // Accessory listings stay out of the device's offer list (REEA-169 f1):
    // the accessory noun keeps the variant label distinct.
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 Phone Silver"),
        canonicalFields("Samsung Galaxy Z Fold7 Case"),
      ),
    ).toBe(false);
  });

  it("REEA-254: swatch bests compare in KWD-space across currencies (item B)", () => {
    // Live QA case reproduced: one card carries a KWD listing and a SAR
    // listing; the swatch chips must read in one unit. Raw numerics would
    // put black first (140 < 1500) and bridge the SAR figure straight into
    // the delta; converted, silver's SAR 1500 is ≈KD 122.4 and leads.
    const products = groupHits("iphone 17 pro", [
      hit({ title: "Apple iPhone 17 Pro 256GB Silver", merchant: "Jarir", currency: "SAR", price: 1500, url: "https://jarir.example/256-s" }),
      hit({ title: "Apple iPhone 17 Pro 256GB Black", merchant: "Xcite", price: 140, url: "https://xcite.example/256-b" }),
    ]);
    expect(products).toHaveLength(1);
    const card = products[0];
    // Converted-cheapest colour leads; deltas are KWD-space cents.
    expect(card.variations).toEqual([
      { id: "silver", label: "Silver", priceDelta: 0 },
      { id: "black", label: "Black", priceDelta: Math.round((140 - 1500 * 0.0816) * 100) / 100 },
    ]);
    // The card header base follows the same comparison: silver's row leads.
    expect(card.offers.map((o) => o.merchant)).toEqual(["Jarir", "Xcite"]);
  });

  it("REEA-254: storage tiers still split; a single colour keeps the plain card", () => {
    // No fuzzy merge across capacities: 512GB is its own decision unit.
    const products = groupHits("iphone 17 pro", [
      hit({ title: 'Apple iPhone 17 Pro 6.3" 256GB - Silver', merchant: "Xcite", price: 429.9, url: "https://xcite.example/256" }),
      hit({ title: "Apple iPhone 17 Pro, 256 GB, Silver, 5G, Apple A19 Pro", merchant: "Jarir", currency: "SAR", price: 1500, url: "https://jarir.example/256" }),
      hit({ title: 'Apple iPhone 17 Pro Max 6.9" 512GB Silver', merchant: "Eureka", price: 520, url: "https://eureka.example/512" }),
    ]);
    expect(products).toHaveLength(2);
    const pro256 = products.find((p) => p.title.includes("6.3"))!;
    // Both spellings of the 256GB tier collapse into the merged card — and
    // the converted-cheapest SAR row leads it (REEA-254 item B: SAR 1500 is
    // ≈KD 122.4 against the KWD 429.9 row).
    expect(pro256.offers.map((o) => o.merchant)).toEqual(["Jarir", "Xcite"]);
    // …one colour only → no swatches (plain single-price card).
    expect(pro256.variations).toEqual([]);
    // The cheapest offer of each tier sits inside its own collapsed card —
    // compared in KWD-space (REEA-254 item B), the card-leading row is the
    // converted-cheapest one across the whole result set.
    const lead = products[0].offers[0];
    expect(toKwdNumeric(lead.price, lead.currency)).toBeLessThanOrEqual(
      Math.min(...products.flatMap((p) => p.offers.map((o) => toKwdNumeric(o.price, o.currency)))),
    );
  });

  it("REEA-254: unbranded spellings share the branded card — the brand role needs a known-brand word", () => {
    // The old fallback consumed the first token as brand even when it was
    // really the model-family opener, so an unbranded "iPhone 17 Pro Max …"
    // (brand `iphone17`) never merged with the branded spelling (brand
    // `apple`) — two cards for one device. With no vocabulary brand the
    // field stays empty and the partial-match rule converges both spellings.
    const products = groupHits("iphone 17 pro max", [
      hit({ title: 'iPhone 17 Pro Max 6.9" 256GB - Deep Blue', merchant: "Xcite", price: 379.9, url: "https://xcite.example/max" }),
      hit({ title: "Apple iPhone 17 Pro Max, 256 GB, Deep Blue, 5G, Apple A19 Pro", merchant: "Jarir", currency: "SAR", price: 1549, url: "https://jarir.example/max" }),
    ]);
    expect(products).toHaveLength(1);
    // Converted-cheapest first: Jarir SAR 1549 ≈KD 126.4 < Xcite KWD 379.9.
    expect(products[0].offers.map((o) => o.merchant)).toEqual(["Jarir", "Xcite"]);
    // An empty brand field does not turn everything into one merge — storage
    // still discriminates across tiers.
    const tiers = groupHits("iphone 17 pro max", [
      hit({ title: 'iPhone 17 Pro Max 6.9" 512GB Deep Blue', merchant: "Xcite", price: 459.9, url: "https://xcite.example/512" }),
      hit({ title: "Apple iPhone 17 Pro Max, 256 GB, Deep Blue", merchant: "Jarir", currency: "SAR", price: 1549, url: "https://jarir.example/256" }),
    ]);
    expect(tiers).toHaveLength(2);
  });

  it("REEA-254: brackets and pipe tails normalize away, so bracketed spellings merge", () => {
    // Live case from the benchmark: Jarir writes the capacity inside brackets
    // and tails the title with "| Tax Paid | 2 Years Official Warranty".
    // Without bracket/pipe normalization the model line forks
    // (`iphone17 pro (256` ≠ `iphone17 pro`) and one SKU shows two cards.
    const products = groupHits("iphone 17 pro", [
      hit({ title: 'Apple iPhone 17 Pro 6.3" 256GB - Silver', merchant: "Xcite", price: 339.9, url: "https://xcite.example/256s" }),
      hit({ title: "Apple iPhone 17 Pro (256 GB) - Silver with Face ID | Tax Paid | 2 Years Official Warranty", merchant: "Jarir", currency: "SAR", price: 1500, url: "https://jarir.example/256s" }),
    ]);
    expect(products).toHaveLength(1);
    // Converted-cheapest leads: Jarir SAR 1500 ≈KD 122.4 < Xcite KWD 339.9.
    expect(products[0].offers.map((o) => o.price)).toEqual([1500, 339.9]);
    // The bracketed capacity still discriminates the tier after normalization.
    expect(canonicalFields("Apple iPhone 17 Pro (256 GB)").storage).toBe("256gb");
    // Cosmic Orange closes on the colour through the widened vocabulary.
    expect(canonicalFields("Apple iPhone 17 Pro Max 6.9 inch 1TB 5G Cosmic Orange").color).toBe("orange");
  });

  it("REEA-254: the same fetched set merges identically regardless of adapter arrival order", () => {
    const base: SearchHit[] = [
      hit({ title: "Apple iPhone 17 Pro Max, 256 GB, Silver, 5G", merchant: "Jarir", currency: "SAR", price: 1500, url: "https://jarir.example/a" }),
      hit({ title: 'Apple iPhone 17 Pro Max 6.9" 256GB Silver', merchant: "Xcite", price: 379.9, url: "https://xcite.example/b" }),
      hit({ title: "Apple iPhone 17 Pro Max 6.9 inch 256GB Deep Blue", merchant: "Eureka", price: 375, url: "https://eureka.example/c" }),
    ];
    // Two consecutive loads: retailers answered in different completion
    // orders; grouping must be a pure function of the fetched set. The card
    // projection (identity, title, offers, swatches) must match exactly —
    // scrapedAt is the run's own completion stamp and stays out of it.
    const shape = (ps: typeof first) =>
      JSON.stringify(
        ps.map((p) => [p.productId, p.title, p.offers, p.variations, p.alternatives]),
      );
    const first = groupHits("iphone 17 pro max", base);
    const second = groupHits("iphone 17 pro max", [base[2], base[0], base[1]]);
    expect(shape(second)).toBe(shape(first));
    // The spec pair merges: verbose and short spellings of one device.
    expect(first).toHaveLength(1);
    // Swatch colours differ → both ride the single card, cheapest in
    // KWD-space first (Jarir SAR 1500 ≈KD 122.4 silver beats Eureka's
    // KWD 375 blue).
    expect(first[0].variations.map((v) => v.id)).toEqual(["silver", "blue"]);
  });

  it("REEA-254 + REEA-488: staged flushes share one alternatives entry", async () => {
    resetDiscoveryCache();
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("xcite.com")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                hits: [
                  { name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true },
                  { name: "Apple AirPods Max", slug: "apm", price: 189, currency: "KWD", inStock: true },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}");
    };
    const staged = collectLiveResultsStaged("airpods", { fetchImpl, country: "KW" });
    const first = await staged.stages[0];
    // Intermediate flush: row identity + offers survive, and the card now
    // reads `alternatives` off every flush too — the payload trim is ENTRY
    // SHARING (one object per referenced group), not emptied arrays.
    expect(first.products.length).toBeGreaterThan(0);
    expect(first.products.some((p) => p.alternatives.length > 0)).toBe(true);
    const finalSnap = await staged.final;
    expect(finalSnap.products.some((p) => p.alternatives.length > 0)).toBe(true);
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
          // Realistic Eureka shape: Algolia app ids are upper-case in the
          // wild ("5GPHMAA239" on the live homepage), so fixtures must be.
          return new Response('<input id="cky" value="A1B2C3D4"><input id="srcapk" value="keyA1b2c3">', { headers: { "content-type": "text/html" } });
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

  it("caches only the hop; offer queries re-run on every call (REEA-141)", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_cached01" y', { headers: { "content-type": "text/html" } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="APPC9"><input id="srcapk" value="keyCkeyC1">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("cnstrc.com")) {
        return jsonResponse({ response: { results: [{ data: { url: "p/s26", price: 1499, metadata: { name: "Samsung Galaxy S26 Ultra" } } }] } });
      }
      if (url.includes("algolia.net")) {
        return jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9001", clprc: 380, avaqt: 2 }] });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({ results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }] });
      }
      return jsonResponse({});
    };

    await collectLiveResults("samsung", { fetchImpl });
    const afterFirst = calls.length;
    await collectLiveResults("samsung", { fetchImpl });

    const homeRuns = calls.filter((u) => u === "https://www.jarir.com/" || u === "https://www.eureka.com.kw/").length;
    expect(homeRuns).toBe(2); // one discovery chain total, not one per call
    expect(afterFirst).toBeGreaterThan(homeRuns);
    // Offers stay live: every call re-queries each retailer's search endpoint
    // (eight across two calls once both algolia-host hops join the set).
    expect(calls.filter((u) => u.includes("cnstrc.com") || u.includes("algolia.net"))).toHaveLength(8);
  });

  it("fails discovery on crafted credentials and never interpolates them into hop URLs (REEA-152)", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.endsWith("eureka.com.kw/")) {
        // Crafted homepage: appId carries an origin + query + fragment; the
        // searchKey is well-formed so only the allowlist check can trip here.
        return new Response(
          '<input id="cky" value="evil.example/?a#"><input id="srcapk" value="validkey12">',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.includes("algolia.net")) return jsonResponse({ hits: [] });
      return jsonResponse({});
    };

    const first = await collectLiveResults("samsung", { fetchImpl });
    const second = await collectLiveResults("samsung", { fetchImpl });

    // Discovery failed closed on both calls…
    expect(first.notes.find((n) => n.merchant === "Eureka")?.error).toBeTruthy();
    expect(second.notes.find((n) => n.merchant === "Eureka")?.error).toBeTruthy();
    // …without poisoning the cache: the mismatch skipped writeDiscovery, so
    // every call re-ran the homepage hop (old code cached after one hop).
    // REEA-290: each call answers with the bounded retry pair — attempt +
    // retry. REEA-437: a fully silent answer additionally gets the ONE
    // widened zero-result round, so two calls land eight hops total, still
    // none from a cached entry.
    expect(calls.filter((u) => u.startsWith("https://www.eureka.com.kw/"))).toHaveLength(8);
    // The crafted value never interpolated into a follow-up fetch URL.
    expect(calls.filter((u) => u.includes("evil.example"))).toHaveLength(0);
  });

  it("survives a transient amazon.eg HTTP 503 with one backed-off retry (REEA-149)", async () => {
    resetDiscoveryCache();
    let amazonCalls = 0;
    const cardsHtml =
      'data-component-type="s-search-result" <h2 aria-label="LG gram 16 Notebook"></h2>' +
      '<span class="a-offscreen">EGP 45,900</span><a href="/dp/B1LGGRM">z</a>';
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("amazon.eg")) {
        amazonCalls++;
        if (amazonCalls === 1) return new Response("busy", { status: 503 });
        return new Response(cardsHtml, { headers: { "content-type": "text/html" } });
      }
      return jsonResponse({});
    };

    const { products, notes } = await collectLiveResults("lg gram", { fetchImpl });

    // The 503 no longer throws past the retry loop: exactly one backed-off
    // retry, and Amazon.eg renders beside the other retailers' pockets.
    expect(amazonCalls).toBe(2);
    expect(notes.find((n) => n.merchant === "Amazon.eg")?.error).toBeFalsy();
    const offers = products.flatMap((p) => p.offers).filter((o) => o.merchant === "Amazon.eg");
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(offers[0]).toMatchObject({ price: 45900, currency: "EGP" });
  });

  it("pins an explicit empty accept-encoding on the amazon.eg hop (REEA-397)", async () => {
    resetDiscoveryCache();
    const cardsHtml =
      'data-component-type="s-search-result" <h2 aria-label="LG gram 16 Notebook"></h2>' +
      '<span class="a-offscreen">EGP 45,900</span><a href="/dp/B1LGGRM">z</a>';
    let amazonHeaders: Headers | undefined;
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("amazon.eg")) {
        amazonHeaders = new Headers(init?.headers);
        return new Response(cardsHtml, { headers: { "content-type": "text/html" } });
      }
      return jsonResponse({});
    };

    await collectLiveResults("lg gram", { fetchImpl });

    // The header must be PRESENT and empty: absent, the Node runtime injects
    // `br, gzip, deflate`, and amazon.eg's edge answers that shape with
    // instant HTTP 503s on most queries from the deployed runtime.
    expect(amazonHeaders?.has("accept-encoding")).toBe(true);
    expect(amazonHeaders?.get("accept-encoding")).toBe("");
  });
});

describe("collectLiveResults depth pass (REEA-149)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Fixture shaped from live answers: the Constructor endpoint answers the
  // bare code "WH-1000XM6" with filler titles that fail relevance, but the
  // brand+code form "Sony WH-1000XM6 ..." returns the real headphone hits.
  function modelCodeFetch(calls: string[]) {
    return async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_reea149x" y', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("cnstrc.com")) {
        const path = decodeURIComponent(url.split("?")[0].replace("https://ac.cnstrc.com/search/", ""));
        if (path.toLowerCase().startsWith("sony")) {
          return jsonResponse({
            response: {
              results: [
                { data: { url: "sony-mark-6", price: 1699, metadata: { name: "Sony Mark 6 Over-Ear Headphones, Active Noise Cancelling, Bluetooth, Wireless, Black" } } },
              ],
            },
          });
        }
        return jsonResponse({ response: { results: [{ data: { url: "ebook", price: 24, metadata: { name: "W W W, eBook" } } }] } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="appr"><input id="srcapk" value="keyr149abc">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones", slug: "xm6", price: 449, currency: "KWD", inStock: true }] }],
        });
      }
      if (url.includes("algolia.net")) {
        return jsonResponse({ hits: [{ itmn: "Sony WH-1000XM6 Headphones", objectID: "7001", clprc: 439, avaqt: 3 }] });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "Sony WH-1000XM6", handle: "xm6", variants: [{ price: "430.00", available: true }] }] });
      }
      if (url.includes("sultan-center.com")) {
        return jsonResponse({ status: "1", products: { product_list: [{ name: "Sony WH-1000XM6", slug: "xm6", price: "425.0000", is_in_stock: "1" }] } });
      }
      return new Response('data-component-type="s-search-result" <h2 aria-label="Sony WH-1000XM6 Headphones"></h2><span class="a-offscreen">EGP 15,900</span><a href="/dp/XM612345">z</a>');
    };
  }

  it("re-queries silent retailers under the enriched brand+code form", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const { products, notes } = await collectLiveResults("WH-1000XM6", { fetchImpl: modelCodeFetch(calls) });

    const cnstrcCalls = calls.filter((u) => u.includes("cnstrc.com"));
    // Raw code first, then exactly one enriched retry — bounded, not per-form.
    expect(cnstrcCalls).toHaveLength(2);
    expect(decodeURIComponent(cnstrcCalls[1])).toContain("Sony WH-1000XM6");

    // Jarir's live offer now renders beside the round-one merchants.
    const merchants = new Set(products.flatMap((p) => p.offers.map((o) => o.merchant)));
    expect(merchants.has("Jarir")).toBe(true);
    expect(merchants.has("Xcite")).toBe(true);
    const jarirNote = notes.find((n) => n.merchant === "Jarir")!;
    expect(jarirNote.hits).toBe(1);
    expect(jarirNote.error).toBeUndefined();
  });

  it("merchants that answered in round one are not re-fetched", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    await collectLiveResults("WH-1000XM6", { fetchImpl: modelCodeFetch(calls) });
    const xciteCalls = calls.filter((u) => u.includes("xcite.com")).length;
    expect(xciteCalls).toBe(1);
  });

  it("answered merchants keep single round-trip chains", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    await collectLiveResults("WH-1000XM6", { fetchImpl: modelCodeFetch(calls) });
    const eurekaHops = calls.filter((u) => u.endsWith("eureka.com.kw/")).length;
    expect(eurekaHops).toBe(1);
  });

  it("skips the enriched round when round one collects nothing at all", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_empty01" y', { headers: { "content-type": "text/html" } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="appe"><input id="srcapk" value="keye149abc">', { headers: { "content-type": "text/html" } });
      }
      return jsonResponse({});
    };
    const { products } = await collectLiveResults("quiet-widget", { fetchImpl });
    expect(products).toHaveLength(0);
    // Round one plus the ONE REEA-437 widened round; the enriched REEA-149
    // depth pass still stays skipped when round one collected nothing.
    expect(calls.filter((u) => u.includes("cnstrc.com"))).toHaveLength(2);
  });
});

describe("collectLiveResults page width (REEA-156)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Thin tail-model fixture: every retailer answers "lg gram" with one
  // relevant hit, so no enriched retry runs and each endpoint is seen once.
  function widthFetch(seen: { url: string; body?: BodyInit | null }[]) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, ...(init?.body != null ? { body: init.body } : {}) });
      if (url === "https://www.jarir.com/") {
        return new Response('x searchProviderKeys "key_width001" y', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("cnstrc.com")) {
        return jsonResponse({ response: { results: [{ data: { url: "lg-gram-16", price: 429, metadata: { name: "LG gram 16 Notebook" } } }] } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="appw"><input id="srcapk" value="keywidth1">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({ results: [{ hits: [{ name: "LG gram 16 Notebook", slug: "lgg16", price: 399, currency: "KWD", inStock: true }] }] });
      }
      if (url.includes("algolia.net")) {
        return jsonResponse({ hits: [{ itmn: "LG gram 16 Notebook", objectID: "8001", clprc: 389, avaqt: 2 }] });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "LG gram 16 Notebook", handle: "lgg16", variants: [{ price: "395.00", available: true }] }] });
      }
      if (url.includes("sultan-center.com")) {
        return jsonResponse({ status: "1", products: { product_list: [{ name: "LG gram 16 Notebook", slug: "lgg16", price: "379.0000", is_in_stock: "1" }] } });
      }
      return new Response('data-component-type="s-search-result" <h2 aria-label="LG gram 16 Notebook"></h2><span class="a-offscreen">EGP 12,900</span><a href="/dp/LGG16161">z</a>');
    };
  }

  it("carries the widened page on every retailer's page-size parameter", async () => {
    resetDiscoveryCache();
    const seen: { url: string; body?: BodyInit | null }[] = [];
    await collectLiveResults("lg gram", { fetchImpl: widthFetch(seen) });
    const n = LIVE_SEARCH_HITS_PER_PAGE;
    const bodyOf = (match: (url: string) => boolean) => {
      const hit = seen.find((s) => match(s.url));
      return typeof hit?.body === "string" ? JSON.parse(hit.body) : undefined;
    };

    const xciteBody = bodyOf((u) => u.includes("xcite.com"));
    expect(xciteBody?.requests?.[0]?.params?.hitsPerPage).toBe(n);
    const eurekaBody = bodyOf((u) => u.includes("algolia.net"));
    expect(String(eurekaBody?.params)).toContain(`hitsPerPage=${n}`);
    const sultanBody = bodyOf((u) => u.includes("sultan-center.com"));
    expect(sultanBody?.pagesize).toBe(n);

    const blink = seen.find((s) => s.url.includes("blink.com.kw"));
    // Shopify hops nest the param (`resources[limit]=24`), the plain hop does
    // not (`limit=24`); assert the number behind either shape.
    expect(blink?.url.match(/limit\D*(\d+)/)?.[1]).toBe(String(n));
    const jarir = seen.find((s) => s.url.includes("cnstrc.com"));
    expect(decodeURIComponent(jarir?.url ?? "")).toContain(`num_results_per_page=${n}`);
  });

  it("Sultan Center re-searches per word when the whole phrase answers empty (REEA-408)", async () => {
    resetDiscoveryCache();
    // Measured live shape 2026-09-09: the mobile API answers `iPhone 17 Pro`
    // and `لابتوب ديل` with an EMPTY product_list while single words answer
    // rows — the collector must ride the same window with a bounded per-word
    // re-search instead of recording the phrase-shaped zero.
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("sultan-center.com")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { search_data?: string };
        const q = String(body.search_data ?? "");
        calls.push(q);
        const rows =
          q === "inspiron" || q === "dell"
            ? [{ name: "Dell Inspiron 15 Laptop", slug: "dl-i15", price: "299.0000", is_in_stock: "1" }]
            : [];
        return jsonResponse({ status: "1", products: { product_list: rows } });
      }
      return jsonResponse({});
    };
    const { notes } = await collectLiveResults("dell inspiron laptop", { fetchImpl });
    expect(calls[0]).toBe("dell inspiron laptop");
    expect(calls).toContain("dell");
    const sultan = notes.find((n) => n.merchant === "Sultan Center");
    expect((sultan?.hits ?? 0)).toBeGreaterThan(0);
  });

  it("keeps the widened page above the thin 12-hit window it replaces", () => {
    // The old 12-hit page measured binding on tail queries (xcite answered a
    // full 12-item page for "airpods pro 2" / "lg gram"); the replacement
    // must stay strictly wider so the depth-of-list fix does not regress.
    expect(LIVE_SEARCH_HITS_PER_PAGE).toBeGreaterThanOrEqual(24);
  });

  it("holds the fan-out window no stricter than the per-retailer budget", () => {
    // REEA-156: deployed loads showed retailers answering inside the page's
    // own ~4 s floor being discarded by a stricter attempt window. The
    // attempt ceiling must stay at or above the product-page collection
    // runner's per-retailer budget it is meant to mirror.
    expect(LIVE_SEARCH_TIMEOUT_MS).toBeGreaterThanOrEqual(PER_RETAILER_TIMEOUT_MS);
    // Two bounded rounds (parallel fan-out + enriched retry), each at most
    // the doubled two-step chain — the documented ceiling covers them both.
    expect(LIVE_SEARCH_BUDGET_MS).toBeGreaterThanOrEqual(LIVE_SEARCH_TIMEOUT_MS * 2 * 2);
  });

  describe("country filter (REEA-170)", () => {
    function jsonResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }

    it("parsers tag hits with their adapter's storefront country", () => {
      const xcite = xciteHits(
        { results: [{ hits: [{ name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true }] }] },
        "airpods",
      );
      expect(xcite[0].country).toBe("KW");
      const jarir = jarirHits(
        { response: { results: [{ data: { url: "p/ap2", price: 909, metadata: { name: "Apple AirPods Pro 2" } } }] } },
        "airpods",
      );
      expect(jarir[0].country).toBe("SA");
      const amz = amazonEgHits(
        'x data-component-type="s-search-result" <h2 aria-label="Apple AirPods Pro 2"></h2><span class="a-offscreen">EGP 11,900</span><a href="/dp/AP1234567">y</a>',
        "airpods",
      );
      expect(amz[0].country).toBe("EG");
    });

    it("Kuwait selection serves only Kuwait-country hits and skips foreign adapters", async () => {
      resetDiscoveryCache();
      const seen: string[] = [];
      const fetchImpl = async (url: string): Promise<Response> => {
        seen.push(url);
        if (url.includes("xcite.com")) {
          return jsonResponse({ results: [{ hits: [{ name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true }] }] });
        }
        if (url.includes("sultan-center.com")) {
          return jsonResponse({ status: "1", products: { product_list: [{ name: "Apple AirPods Pro 2", slug: "app2", price: "69.9000", is_in_stock: "1" }] } });
        }
        return new Response("nope");
      };
      const { products } = await collectLiveResults("airpods", { fetchImpl, country: "KW" });
      expect(products).toHaveLength(1);
      const merchants = products[0].offers.map((o) => o.merchant);
      expect(merchants).toContain("Xcite");
      expect(merchants).toContain("Sultan Center");
      expect(merchants).not.toContain("Jarir");
      expect(merchants).not.toContain("Amazon.eg");
      // Rate-limit citizenship: foreign adapters are not even contacted when
      // their hits could only be filtered out.
      expect(seen.some((u) => u.includes("cnstrc.com"))).toBe(false);
      expect(seen.some((u) => u.includes("amazon.eg"))).toBe(false);
    });

    it("Lulu falls through to the Static-IPs hop when both identity paths land on the interstitial (REEA-416)", async () => {
      resetDiscoveryCache();
      // Measured shape 2026-09-10: from cloud egress every rotating identity
      // on the hostname hop returns the CF interstitial, while the per-IP
      // passes (fresh challenge decision per connection) can answer the real
      // JSON-LD page. The Arabic grocery probe must then score the basmati
      // row through the shared gate (ارز/بسمتي → rice/basmati).
      const seen: string[] = [];
      const ld = JSON.stringify({
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "Item",
            item: {
              "@type": "Product",
              name: "Country Xl Organic Basmati Rice",
              offers: {
                "@type": "Offer",
                price: "2.3100",
                priceCurrency: "KWD",
                availability: "https://schema.org/InStock",
                url: "/en/country-xl-organic-basmati-rice-2-kg",
              },
            },
          },
        ],
      });
      const fetchImpl = async (url: string): Promise<Response> => {
        seen.push(url);
        if (url.startsWith("http://")) {
          return new Response(`<html><head><script type="application/ld+json">${ld}</script></head><body>ok</body></html>`);
        }
        return new Response('<html><head><script>document.cookie="cf_clearance=t"</script></head><body>cf-error-details</body></html>');
      };
      const { notes } = await collectLiveResults("\u0627\u0631\u0632 \u0628\u0633\u0645\u062a\u064a", { fetchImpl, country: "KW" });
      const lulu = notes.find((n) => n.merchant === "Lulu Hypermarket");
      expect(lulu?.hits ?? 0).toBeGreaterThanOrEqual(1);
      expect(seen.some((u) => /^http:\/\/\d/.test(u))).toBe(true);
    });

    it("Lulu keeps hopping past a JSON-LD-less CF shell without an error marker (REEA-526)", async () => {
      resetDiscoveryCache();
      // Measured shape on the deployed path 2026-09-10: the CF interstitial
      // (~5.5 KB) carries ZERO application/ld+json blocks and no
      // cf-error-details marker, so a length-and-marker check alone returns
      // it as an answer and the column goes silently zero. Presence of the
      // contract's ld+json blocks is what qualifies a body for the parse;
      // until then the bounded clearance / per-IP hops keep running.
      const seen: string[] = [];
      const ld = JSON.stringify({
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "Item",
            item: {
              "@type": "Product",
              name: "Country Xl Organic Basmati Rice",
              offers: {
                "@type": "Offer",
                price: "2.3100",
                priceCurrency: "KWD",
                availability: "https://schema.org/InStock",
                url: "/en/country-xl-organic-basmati-rice-2-kg",
              },
            },
          },
        ],
      });
      const fetchImpl = async (url: string): Promise<Response> => {
        seen.push(url);
        if (url.startsWith("http://")) {
          return new Response(`<html><head><script type="application/ld+json">${ld}</script></head><body>ok</body></html>`);
        }
        // Interstitial shell: no ld+json block, no error marker. The inline
        // cookie script lets the bounded clearance pass settle quickly.
        return new Response('<html><head><script>document.cookie="cf_clearance=t"</script></head><body>Verifying your browser</body></html>');
      };
      const { notes } = await collectLiveResults("\u0627\u0631\u0632 \u0628\u0633\u0645\u062a\u064a", { fetchImpl, country: "KW" });
      const lulu = notes.find((n) => n.merchant === "Lulu Hypermarket");
      expect(lulu?.hits ?? 0).toBeGreaterThanOrEqual(1);
      expect(lulu?.error).toBeUndefined();
      expect(seen.some((u) => /^http:\/\/\d/.test(u))).toBe(true);
      // Timeout sizing: the hop chain behind this assertion (identity hop ->
      // bounded JSD clearance poll -> per-IP passes) rides fixed 250/700 ms
      // cadences after the completion clock, measured ~5-6 s on the Vercel
      // builder (REEA-572 pickup log: this case red at 5005 ms there while
      // green on a local shell). Give it a window above the default 5 s so
      // the deploy gate measures the hop logic, not runner speed.
    }, 15000);

    it("without a selection every adapter keeps serving (default unchanged)", async () => {
      resetDiscoveryCache();
      const fetchImpl = async (url: string): Promise<Response> => {
        if (url.endsWith("jarir.com/")) {
          return new Response('x searchProviderKeys "key_test123456" y', { headers: { "content-type": "text/html" } });
        }
        if (url.includes("cnstrc.com")) {
          return jsonResponse({ response: { results: [{ data: { url: "p/ap2", price: 909, metadata: { name: "Apple AirPods Pro 2" } } }] } });
        }
        if (url.includes("xcite.com")) {
          return jsonResponse({ results: [{ hits: [{ name: "Apple AirPods Pro 2", slug: "app2", price: 74, currency: "KWD", inStock: true }] }] });
        }
        if (url.includes("amazon.eg")) {
          return new Response('data-component-type="s-search-result" <h2 aria-label="Apple AirPods Pro 2"></h2><span class="a-offscreen">EGP 11,900</span><a href="/dp/AP1234567">y</a>');
        }
        return new Response("nope");
      };
      const { products } = await collectLiveResults("airpods", { fetchImpl });
      expect(products).toHaveLength(1);
      const merchants = products[0].offers.map((o) => o.merchant);
      // All "All": foreign listings stay on the page, exactly as today.
      expect(merchants).toContain("Xcite");
      expect(merchants).toContain("Jarir");
      expect(merchants).toContain("Amazon.eg");
    });
  });
});

describe("collectLiveResultsStaged (REEA-178)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Fast KW electronics retailers answer immediately; the two-step Eureka
  // chain and the slow Sultan storefront answer after a short delay — so the
  // first flush must already serve while those hops are still in flight.
  function mixedSpeedFetch(): FetchImplLike {
    return async (url: string): Promise<Response> => {
      if (url.endsWith("eureka.com.kw/")) {
        return new Promise((res) =>
          setTimeout(
            () => res(new Response('<input id="cky" value="APPS1"><input id="srcapk" value="keyStage01">', { headers: { "content-type": "text/html" } })),
            30,
          ),
        );
      }
      if (url.includes("algolia.net")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9101", clprc: 379, avaqt: 3 }] }),
              ),
            30,
          ),
        );
      }
      if (url.includes("sultan-center.com")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                jsonResponse({
                  status: "1",
                  products: { product_list: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: "385.0000", is_in_stock: "1" }] },
                }),
              ),
            30,
          ),
        );
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }],
        });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "Samsung Galaxy S26 Ultra", handle: "s26u", variants: [{ price: "390.00", available: true }] }] });
      }
      return jsonResponse({});
    };
  }

  type FetchImplLike = (url: string, init?: RequestInit) => Promise<Response>;

  it("the first offer lands with the first answer while late merchants stream into the final flush (REEA-277)", async () => {
    resetDiscoveryCache();
    const staged = collectLiveResultsStaged("samsung", { fetchImpl: mixedSpeedFetch(), country: "KW" });

    // One boundary per KW retailer in the run (seventeen since REEA-378).
    expect(staged.stages).toHaveLength(17);

    const first = await staged.stages[0];
    expect(first.products).toHaveLength(1);
    // REEA-277: stage 0 opens when the FIRST round-one answer lands — the fast
    // Xcite hop is on screen while the delayed Eureka/Sultan hops are still in
    // flight. Each flush renders the tier ladder over everything answered so
    // far, and the converged final carries the full-ranked union.
    expect(first.products[0].offers.some((o) => o.merchant === "Xcite")).toBe(true);
    expect(first.notes.some((n) => n.merchant === "Eureka")).toBe(false);
    // AC-3: every snapshot carries its own real completion stamp.
    expect(Date.now() - Date.parse(first.products[0].scrapedAt!)).toBeLessThan(5_000);

    const finalSnap = await staged.final;
    const merchants = new Set(finalSnap.products.flatMap((p) => p.offers.map((o) => o.merchant)));
    // AC-2 on the data side: the early card survives into the final flush as
    // the FIRST card, carrying the merged union (cheapest first).
    expect(finalSnap.products[0].productId).toBe(first.products[0].productId);
    expect(finalSnap.products[0].offers.map((o) => o.price)).toEqual([379, 385, 390, 399]);
    expect(merchants.has("Eureka")).toBe(true);
    expect(merchants.has("Sultan Center")).toBe(true);
    // Merchants whose mocks never answer are all reported as notes (seventeen
    // of the seventeen retailers).
    expect(finalSnap.notes).toHaveLength(17);
  });

  it("the final flush equals the blocking path on the same live answers", async () => {
    resetDiscoveryCache();
    const staged = await collectLiveResultsStaged("samsung", { fetchImpl: mixedSpeedFetch(), country: "KW" }).final;
    const blocking = await collectLiveResults("samsung", { fetchImpl: mixedSpeedFetch(), country: "KW" });
    const shape = (s: typeof staged) => s.products.map((p) => [p.productId, p.offers.map((o) => `${o.merchant}:${o.price}`)]);
    expect(shape(staged)).toEqual(shape(blocking));
  });
});

describe("completion-budget finalize (REEA-398)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  type FetchImplLike = (url: string, init?: RequestInit) => Promise<Response>;

  // The fast hops (Xcite, Blink, the plain-archive retailers) answer at
  // once; the two-step Eureka chain and the Sultan Center storefront land
  // AFTER the finalize deadline but inside the hop window — so the stream
  // closes on budget with the landed offers plus honest coverage notes,
  // while the late ones converge into the follow-up feed right after.
  function lateTailFetch(delayMs = 120): FetchImplLike {
    return async (url: string): Promise<Response> => {
      if (url.endsWith("eureka.com.kw/")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                new Response('<input id="cky" value="APPS1"><input id="srcapk" value="keyStage01">', {
                  headers: { "content-type": "text/html" },
                }),
              ),
            delayMs,
          ),
        );
      }
      if (url.includes("algolia.net")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                jsonResponse({ hits: [{ itmn: "Samsung Galaxy S26 Ultra", objectID: "9101", clprc: 379, avaqt: 3 }] }),
              ),
            delayMs,
          ),
        );
      }
      if (url.includes("sultan-center.com")) {
        return new Promise((res) =>
          setTimeout(
            () =>
              res(
                jsonResponse({
                  status: "1",
                  products: { product_list: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: "385.0000", is_in_stock: "1" }] },
                }),
              ),
            delayMs,
          ),
        );
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "Samsung Galaxy S26 Ultra", slug: "s26u", price: 399, currency: "KWD", inStock: true }] }],
        });
      }
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "Samsung Galaxy S26 Ultra", handle: "s26u", variants: [{ price: "390.00", available: true }] }] });
      }
      return jsonResponse({});
    };
  }

  it("finalizes on the completion budget with honest coverage notes while late hops are still in flight", async () => {
    resetDiscoveryCache();
    const staged = collectLiveResultsStaged("samsung", { fetchImpl: lateTailFetch(), country: "KW", deadlineMs: 40 });

    const snap = await staged.final;
    // The finalized document carries everything that landed inside the budget…
    const merchants = new Set(snap.products.flatMap((p) => p.offers.map((o) => o.merchant)));
    expect(merchants.has("Xcite")).toBe(true);
    expect(merchants.has("Eureka")).toBe(false);
    // …plus one honest budget note per still-silent merchant: the coverage
    // line of the FINALIZED page names every gap, with the budget as its
    // reason — across all seventeen KW retailers in the run.
    expect(snap.notes).toHaveLength(17);
    expect(snap.notes.find((n) => n.merchant === "Eureka")?.error).toMatch(/completion budget/);
    expect(snap.notes.find((n) => n.merchant === "Sultan Center")?.error).toMatch(/completion budget/);
    // The page clock sits inside the brief's 4-5 s window.
    expect(RESULTS_COMPLETION_BUDGET_MS).toBeLessThanOrEqual(5_000);
  });

  it("late offers land through the follow-up feed from the SAME run, no second fan-out", async () => {
    resetDiscoveryCache();
    const cache = createQueryCache();
    const staged = collectLiveResultsStaged("samsung", {
      fetchImpl: lateTailFetch(),
      cache,
      country: "KW",
      deadlineMs: 40,
    });

    // Finalized at the budget: only the immediate hops are on the page.
    const finalized = await staged.final;
    expect(finalized.products[0].offers).toHaveLength(2);

    // The follow-up feed reads the SAME in-flight chain: the late Eureka and
    // Sultan hops fold in without any re-fetch of the retailers that already
    // answered — the feed hands over the run's own converged snapshot.
    const late = await followUpSnapshot("samsung");
    expect(late).not.toBeNull();
    const lateMerchants = new Set(late!.products.flatMap((p) => p.offers.map((o) => o.merchant)));
    expect(lateMerchants.has("Eureka")).toBe(true);
    expect(lateMerchants.has("Sultan Center")).toBe(true);
    expect(late!.products[0].offers.map((o) => o.price)).toEqual([379, 385, 390, 399]);

    // The converged write-through leaves the COMPLETE live answer in the
    // cache, so the next identical query inside the memo window gets the
    // full coverage immediately.
    const memo = cache.read<{ products: { offers: unknown[] }[] }>("samsung");
    expect(memo).not.toBeNull();
    expect(memo!.value.products[0].offers).toHaveLength(4);
  });
});

describe("query memo window (REEA-291 AC5)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  // Every hop answers instantly; Xcite is the one retailer with an offer so
  // the converged snapshot is non-empty and rides the write-through.
  function countingFetch(calls: string[]) {
    return async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "Sony WH-1000XM6", slug: "xm6", price: 120, currency: "KWD", inStock: true }] }],
        });
      }
      return jsonResponse({});
    };
  }

  it("a repeat inside the fresh window serves the cached live answer with no second hop", async () => {
    resetDiscoveryCache();
    const cache = createQueryCache();
    const calls: string[] = [];
    const fetchImpl = countingFetch(calls);

    const cold = await collectLiveResultsStaged("xm6", { fetchImpl, cache }).final;
    expect(cold.products).toHaveLength(1);
    const coldCalls = calls.length;
    expect(cache.size()).toBe(1);

    // Repeat of the SAME query inside the fresh window: the last live answer
    // serves immediately and NO hop runs — the AC5 ≤50% ratio rides on this
    // being zero-hop. The memo keys on the NORMALIZED QUERY STRING ONLY, so
    // a differently-cased/padded repeat shares the entry (no fork).
    const warm = await collectLiveResultsStaged(" XM6 ", { fetchImpl, cache }).final;
    expect(calls.length).toBe(coldCalls);
    expect(warm.products).toEqual(cold.products);
  });

  it("the explicit Refresh re-runs the live fan-out inside the fresh window", async () => {
    resetDiscoveryCache();
    const cache = createQueryCache();
    const calls: string[] = [];
    const fetchImpl = countingFetch(calls);

    await collectLiveResultsStaged("xm6", { fetchImpl, cache }).final;
    const coldCalls = calls.length;

    // AC4's Refresh: no fresh-window shortcut. The cached answer still leads
    // as the first flush, the live fan-out re-runs behind it, and the fresh
    // stamps ride the converged write-through.
    const refreshed = collectLiveResultsStaged("xm6", { fetchImpl, cache, refresh: true });
    expect(refreshed.stages.length).toBeGreaterThan(1);
    const finalSnap = await refreshed.final;
    expect(calls.length).toBeGreaterThan(coldCalls);
    expect(finalSnap.products).toHaveLength(1);
  });
});

describe("brand chain (REEA-189)", () => {
  it("reads the retailer brand field into hits when the contract carries one", () => {
    const hits = xciteHits(
      { results: [{ hits: [{ name: "Sony WH-1000XM6 Wireless Headphones", slug: "xm6", price: 120, currency: "KWD", inStock: true, brand: "SONY" }] }] },
      "wh-1000xm6",
    );
    expect(hits[0].brand).toBe("SONY");
  });

  it("Shopify vendor rides into the hit brand", () => {
    const hits = blinkHits(
      { products: [{ title: "Bose QuietComfort Ultra Earbuds", handle: "qcues", vendor: "Bose", variants: [{ price: "89.00", available: true }] }] },
      "bose quietcomfort",
    );
    expect(hits[0].brand).toBe("Bose");
  });

  it("a retailer without a brand field inherits the merged group's first brand", () => {
    const products = groupHits("bose qc", [
      { title: "Bose QuietComfort Ultra Earbuds", merchant: "Xcite", country: "KW", price: 90, currency: "KWD", url: "https://www.xcite.com/qc/p", inStock: true, brand: "BOSE" },
      { title: "Bose QuietComfort Ultra Earbuds Black", merchant: "Eureka", country: "KW", price: 85, currency: "KWD", url: "https://www.eureka.com.kw/qc", inStock: true },
    ]);
    const card = products.find((p) => p.offers.some((o) => o.merchant === "Eureka"));
    expect(card?.brand).toBe("Bose");
  });

  it("artifact stop-values and missing fields fall back to the curated title match, never a first word", () => {
    const products = groupHits("compatible airfryer", [
      { title: "Airfryer XL Basket Non-Stick", merchant: "Xcite", country: "KW", price: 25, currency: "KWD", url: "https://www.xcite.com/af/p", inStock: true, brand: "Case" },
      { title: "Compatible with Philips Airfryer XL", merchant: "Eureka", country: "KW", price: 22, currency: "KWD", url: "https://www.eureka.com.kw/af", inStock: true },
    ]);
    // "Case"/missing brand → curated whole-word match on the title, not the first word.
    expect(products.find((p) => p.title.startsWith("Compatible"))?.brand).toBe("Philips");
    // No curated brand anywhere and a stop-value field → honest "no brand line".
    const plain = groupHits("basket", [
      { title: "Basket Non-Stick 5L", merchant: "Xcite", country: "KW", price: 9, currency: "KWD", url: "https://www.xcite.com/b/p", inStock: true, brand: "Privacy" },
    ]);
    expect(plain[0].brand).toBe("");
  });
});

describe("relevance-first ranking (REEA-213 Bet 1, REEA-211 acceptance)", () => {
  it("query `iPhone 17 Pro`: phone cards lead, plain Pro before Pro Max, the cheap case sits below", () => {
    const products = groupHits("iPhone 17 Pro", [
      hit({ title: "Techpick Bundle Pack for Apple iPhone 17 Pro Series", merchant: "Blink", price: 19.9, url: "https://blink.example/pack", brand: "Techpick" }),
      hit({ title: "Apple iPhone 17 Pro Max 512GB Black", merchant: "Jarir", country: "SA", currency: "SAR", price: 470, url: "https://jarir.example/17pm", brand: "Apple" }),
      hit({ title: "Case for iPhone 17 Pro Silicone Cover Black", merchant: "Amazon.eg", country: "EG", currency: "EGP", price: 9.9, url: "https://amazon.example/dp/c1", brand: "RINGKE" }),
      hit({ title: "Apple iPhone 17 Pro Max 256GB Black", merchant: "Eureka", price: 429.9, url: "https://eureka.example/17pm", brand: "Apple" }),
      hit({ title: "Apple iPhone 17 Pro, 256 GB Black", merchant: "Xcite", price: 449.9, url: "https://xcite.example/17p", brand: "Apple" }),
      hit({ title: "Razer Viper V4 Pro Wireless Gaming Mouse for iPhone", merchant: "Blink", price: 29, url: "https://blink.example/mouse", brand: "Razer" }),
    ]);
    // Tier 1 (head-name phones) before tier 2 (bundle/case) before tier 3
    // (single-token cross-category); price never blends the blocks: the 9.9
    // case outranks nothing above the phone block.
    expect(products.map((p) => p.title)).toEqual([
      "Apple iPhone 17 Pro, 256 GB Black",
      "Apple iPhone 17 Pro Max 256GB Black",
      "Apple iPhone 17 Pro Max 512GB Black",
      "Techpick Bundle Pack for Apple iPhone 17 Pro Series",
      "Case for iPhone 17 Pro Silicone Cover Black",
      "Razer Viper V4 Pro Wireless Gaming Mouse for iPhone",
    ]);
    // Single badge: the first in-stock card of the final order is a phone,
    // never the cheaper Amazon.eg case card.
    expect(bestBadgeIndex(products)).toBe(0);
  });

  it("query `غسالة`: branded washers beat the toy, paint variants last, badge on the washer", () => {
    const washer = hit({ title: "غسالة فريش 10 كجم حوض واحد", merchant: "Xcite", price: 89, url: "https://xcite.example/w1", brand: "Fresh" });
    const toy = hit({ title: "غسالة، لعب الاطفال التظاهر", merchant: "Jarir", country: "SA", currency: "SAR", price: 12, url: "https://jarir.example/toy", brand: "Non Branded" });
    const paint = hit({ title: "Marabu Air Top Color 250ml آمن للغسل في غسالة الاطباق", merchant: "Sultan Center", price: 4, url: "https://sultan.example/p1", brand: "Marabu" });
    const products = groupHits("غسالة", [paint, toy, washer]);
    expect(products.map((p) => p.title)).toEqual([
      "غسالة فريش 10 كجم حوض واحد",
      "غسالة، لعب الاطفال التظاهر",
      "Marabu Air Top Color 250ml آمن للغسل في غسالة الاطباق",
    ]);
    // Accepted tradeoff: the branded washer keeps the badge though the toy
    // and the paint are cheaper.
    expect(bestBadgeIndex(products)).toBe(0);
  });

  it("query `iPhone 17 Pro Max`: Pro Max phones lead, plain Pro falls below them", () => {
    const products = groupHits("iPhone 17 Pro Max", [
      hit({ title: "Clear Case for iPhone 17 Pro Max Silicone", merchant: "Blink", price: 9.9, url: "https://blink.example/c2", brand: "RINGKE" }),
      hit({ title: "Apple iPhone 17 Pro Max, 512 GB Black", merchant: "Jarir", country: "SA", currency: "SAR", price: 470, url: "https://jarir.example/17pm5", brand: "Apple" }),
      hit({ title: "Apple iPhone 17 Pro Max 256GB Black", merchant: "Eureka", price: 429.9, url: "https://eureka.example/17pm", brand: "Apple" }),
      hit({ title: "Apple iPhone 17 Pro, 256 GB Black", merchant: "Xcite", price: 449.9, url: "https://xcite.example/17p", brand: "Apple" }),
    ]);
    expect(products.map((p) => p.title)).toEqual([
      "Apple iPhone 17 Pro Max 256GB Black",
      "Apple iPhone 17 Pro Max, 512 GB Black",
      "Clear Case for iPhone 17 Pro Max Silicone",
      "Apple iPhone 17 Pro, 256 GB Black",
    ]);
    expect(bestBadgeIndex(products)).toBe(0);
  });

  it("REEA-222: a zero-token cross-category card sits below the phones, badge on the cheapest Pro Max", () => {
    // Live-shape repro from QA (REEA-222 Q3): the cheap Instax camera
    // answers none of the query tokens; it must not ride the lead bucket on
    // its low price and steal the single badge from the phones.
    const products = groupHits("iPhone 17 Pro Max", [
      hit({ title: "Fujifilm Instax Mini 41 Instant Camera, Classic Design", merchant: "Blink", price: 44, url: "https://blink.example/instax", brand: "Fujifilm" }),
      hit({ title: "Apple iPhone 17 Pro Max 256GB Orange", merchant: "Xcite", price: 379.9, url: "https://xcite.example/17pmo", brand: "Apple" }),
      hit({ title: "Apple iPhone 17 Pro Max 512GB Black", merchant: "Jarir", country: "SA", currency: "SAR", price: 429.9, url: "https://jarir.example/17pm5", brand: "Apple" }),
    ]);
    expect(products.map((p) => p.title)).toEqual([
      "Apple iPhone 17 Pro Max 256GB Orange",
      "Apple iPhone 17 Pro Max 512GB Black",
      "Fujifilm Instax Mini 41 Instant Camera, Classic Design",
    ]);
    // The badge follows the lead phone card, never the cheaper camera.
    expect(bestBadgeIndex(products)).toBe(0);
  });

  it("query `Case for iPhone 17 Pro`: the ladder flips — case cards lead the phones", () => {
    const products = groupHits("Case for iPhone 17 Pro", [
      hit({ title: "Apple iPhone 17 Pro Max, 256 GB Black", merchant: "Jarir", country: "SA", currency: "SAR", price: 470, url: "https://jarir.example/17pm", brand: "Apple" }),
      hit({ title: "Case for iPhone 17 Pro Silicone Cover Black", merchant: "Amazon.eg", country: "EG", currency: "EGP", price: 9.9, url: "https://amazon.example/dp/c1", brand: "RINGKE" }),
    ]);
    expect(products.map((p) => p.title)).toEqual([
      "Case for iPhone 17 Pro Silicone Cover Black",
      "Apple iPhone 17 Pro Max, 256 GB Black",
    ]);
    expect(bestBadgeIndex(products)).toBe(0);
  });

  it("query `غسّالة` with shadda returns the identical order of `غسالة`", () => {
    const fixtures = [
      hit({ title: "Marabu Air Top Color 250ml آمن للغسل في غسالة الاطباق", merchant: "Sultan Center", price: 4, url: "https://sultan.example/p1", brand: "Marabu" }),
      hit({ title: "غسالة، لعب الاطفال التظاهر", merchant: "Jarir", country: "SA", currency: "SAR", price: 12, url: "https://jarir.example/toy", brand: "Non Branded" }),
      hit({ title: "غسالة فريش 10 كجم حوض واحد", merchant: "Xcite", price: 89, url: "https://xcite.example/w1", brand: "Fresh" }),
    ];
    const plain = groupHits("غسالة", fixtures);
    const vowelled = groupHits("غسّالة", fixtures);
    expect(vowelled.map((p) => p.title)).toEqual(plain.map((p) => p.title));
    expect(vowelled.length).toBeGreaterThan(0);
  });
});

describe("whole-chain budget signal (REEA-224 F4)", () => {
  it("threads a signal into every hop fetch of the blocking path", async () => {
    const signals: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return new Response("<html>no cards</html>");
    };
    await collectLiveResults("airpods", { fetchImpl, country: "EG" });
    expect(signals.length).toBeGreaterThan(0);
    // Every hop carried the joined budget|attempt signal — the abort path
    // exists end to end, not just on the per-attempt windows.
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("cuts a stalled retailer at the bounded hop window instead of hanging", async () => {
    resetDiscoveryCache();
    // Stall-until-abort fixture: the promise only settles when the threaded
    // signal fires. Without budget threading through fetchChecked there is no
    // event at all and this call would hang until the harness timeout.
    const stalled = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve) => {
        const signal = init?.signal;
        const settle = () => resolve(new Response(JSON.stringify({ hits: [], products: [], results: [] })));
        if (!signal) return;
        if (signal.aborted) settle();
        else signal.addEventListener("abort", settle, { once: true });
      });
    const t0 = Date.now();
    const { notes } = await collectLiveResults("samsung", { fetchImpl: stalled, country: "KW" });
    const elapsed = Date.now() - t0;
    // The slowest bounded hop is the two-step chain at TIMEOUT×2 (~8 s); the
    // whole run must settle there — measured "~7.5 s" on the edge — and never
    // drift past the documented LIVE_SEARCH_BUDGET_MS ceiling.
    expect(elapsed).toBeGreaterThanOrEqual(LIVE_SEARCH_TIMEOUT_MS * 2 - 1_500);
    expect(elapsed).toBeLessThan(LIVE_SEARCH_BUDGET_MS + 2_000);
    // Graceful degradation: every silent retailer is still reported (all
    // seventeen KW collectors are stalled here, REEA-378 included).
    expect(notes).toHaveLength(17);
  }, 25_000);
});

describe("REA-290 — retry once with backoff + per-query coverage line", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }

  it("retries a 403-blipped retailer once and serves its offers", async () => {
    resetDiscoveryCache();
    let xciteCalls = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("xcite.com")) {
        xciteCalls++;
        if (xciteCalls === 1) return new Response("forbidden", { status: 403 });
        return jsonResponse({
          results: [{ hits: [{ name: "AirPods Pro", slug: "app", price: 74, currency: "KWD", inStock: true }] }],
        });
      }
      return new Response("{}");
    };
    const { products, notes } = await collectLiveResults("airpods pro", { fetchImpl, country: "KW" });
    // Exactly one bounded retry — attempt + backoff + attempt, then served.
    expect(xciteCalls).toBe(2);
    expect(notes.find((n) => n.merchant === "Xcite")?.error).toBeFalsy();
    expect(products.some((p) => p.offers.some((o) => o.merchant === "Xcite"))).toBe(true);
  });

  it("names a stuck 403 retailer in the note after the retry, others keep serving", async () => {
    resetDiscoveryCache();
    let blinkCalls = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("blink.com.kw")) {
        blinkCalls++;
        return new Response("forbidden", { status: 403 });
      }
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [{ hits: [{ name: "AirPods Pro", slug: "app", price: 74, currency: "KWD", inStock: true }] }],
        });
      }
      return new Response("{}");
    };
    const { products, notes } = await collectLiveResults("airpods pro", { fetchImpl, country: "KW" });
    // Attempt + the one bounded retry (the REEA-149 deepen round answers the
    // enriched query too — title equals the query here, so it stays out).
    expect(blinkCalls).toBe(2);
    expect(notes.find((n) => n.merchant === "Blink")).toMatchObject({ error: "HTTP 403", hits: 0 });
    // Graceful degradation: the failing retailer never blanks the others.
    expect(products.some((p) => p.offers.some((o) => o.merchant === "Xcite"))).toBe(true);
  });

  it("names the rendered retailers and the errored ones, in fixed adapter order", () => {
    // Arrival order (Blink first) must not leak into the sentence — the same
    // settled set reads identically on consecutive loads (REEA-254 rule).
    // REEA-574 rev 1 (R1): the contributor half reads the RENDERED rows.
    expect(coverageLine(["Blink", "Xcite"], ["Jarir"])).toBe(
      "No response from Jarir. Prices from Xcite and Blink.",
    );
    // An adapter that answered but rendered no rows stays unnamed — rendered
    // rows, not adapter hit counts, decide the contributor half.
    expect(coverageLine(["Eureka", "Xcite"])).toBe("Prices from Xcite and Eureka.");
    expect(coverageLine(["Xcite", "Blink"])).toBe("Prices from Xcite and Blink.");
    // Nothing rendered on the page hides the whole sentence — an empty page
    // shows heading + hint + empty state only, never a name list.
    expect(coverageLine([], ["Xcite", "Blink"])).toBe("");
    // Nothing collected yet: no line, no flicker.
    expect(coverageLine([])).toBe("");
  });
});

describe("REEA-270 — Kuwait batch two adapters", () => {
  it("switchHits reads the suggest envelope with KWD figures and the KW tag", () => {
    // Live shape (switch.com.kw/search/suggest.json, captured 2026-09-08):
    // price/availability ride the product itself in the suggest envelope —
    // the fold feeds them into the same guard chain as blink's hop.
    const hits = switchHits(
      {
        resources: {
          results: {
            products: [
              { title: "Nike Air Max Dn Mens Shoes", handle: "nike-air-max-dn", available: true, price: "25.000", vendor: "Nike" },
              { title: "Cotton Pads 50g", handle: "cotton-pads", available: true, price: "1.000" },
            ],
          },
        },
      },
      "nike",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Switch",
      country: "KW",
      brand: "Nike",
      price: 25,
      currency: "KWD",
      url: "https://switch.com.kw/products/nike-air-max-dn",
      inStock: true,
    });
  });

  it("switchHits folds the classic products.json envelope too, compare-at becomes wasPrice", () => {
    // The newest-page hop answers the classic {products:[{variants:[…]}]}
    // shape; the shared fold keeps the wasPrice convention of quadraHits.
    const hits = switchHits(
      {
        products: [
          {
            title: "Adidas Gazelle Trainer",
            handle: "gazelle",
            variants: [{ price: "19.00", compare_at_price: "29.00", available: false }],
          },
        ],
      },
      "adidas gazelle",
    );
    expect(hits[0]).toMatchObject({ merchant: "Switch", price: 19, wasPrice: 29, inStock: false });
  });

  it("wibiHits and zayoomHits read their suggest envelopes with store-native URLs", () => {
    const payload = {
      resources: {
        results: {
          products: [
            { title: "Dyson V15 Detect Absolute", handle: "dyson-v15", available: true, price: "120.000", vendor: "Dyson" },
          ],
        },
      },
    };
    expect(wibiHits(payload, "dyson v15")[0]).toMatchObject({
      merchant: "Wibi",
      country: "KW",
      price: 120,
      currency: "KWD",
      url: "https://wibi.com.kw/products/dyson-v15",
    });
    expect(zayoomHits(payload, "dyson v15")[0]).toMatchObject({
      merchant: "Zayoom",
      country: "KW",
      price: 120,
      url: "https://zayoom.com/products/dyson-v15",
    });
  });

  it("astoreHits drops handle-less rows like the other Shopify parsers", () => {
    const hits = astoreHits(
      {
        products: [
          { title: "Nescafe Classic 200g", variants: [{ price: "2.50" }] },
          { title: "Nescafe Gold 50g", handle: "nescafe-gold", variants: [{ price: "1.25", available: true }] },
        ],
      },
      "nescafe",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ merchant: "Astore", country: "KW", price: 1.25, currency: "KWD" });
  });

  it("yousifiHits reads WooCommerce archive cards off the product search page", () => {
    // Same WooCommerce/Electro card shape as the PC Kuwait archive hop (the
    // shared scanWooCards scanner): loop link wraps the h2 title, lone price
    // span when no promo runs, KD spelled as KWD.
    const html =
      '<li class="product"><a href="https://www.yousifi.com.kw/shop/nestle-nescafe-classic/" class="woocommerce-loop-product__link">' +
      '<h2 class="woocommerce-loop-product__title">Nescafe Classic Coffee 200g</h2></a>' +
      '<span class="price"><span class="woocommerce-Price-amount amount"><span class="woocommerce-Price-currencySymbol">KD</span>&nbsp;2.250</span></span></li>';
    const hits = yousifiHits(html, "nescafe coffee");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Yousifi",
      country: "KW",
      price: 2.25,
      currency: "KWD",
      url: "https://www.yousifi.com.kw/shop/nestle-nescafe-classic/",
    });
  });

  it("asterHits reads hydration records off the Aster search SSR payload", () => {
    // Record shape measured live 2026-09-09 off the myaster.com search hop:
    // inline sku/name/brand/inStock records, promo price as special_price
    // under the list price, productUrl as a /p/<slug>/<sku> path, titles
    // carrying \u0026 escapes. A second record with no query coverage must
    // stay out of the hits.
    const html =
      '<div id="__next"><script>{"sku":"1068110","name":"Vichy Dercos Serum 90ml \\u0026 more",' +
      '"brand":"Vichy","quantity":3,"inStock":true,' +
      '"productUrl":"/p/vichy-serum/1068110","itemLabels":["NONRX"],"currency":"KD",' +
      '"price":9.9,"special_price":7.4,"media_gallery_entries":[{"url":"https://media.myaster.com/x.jpg"}]},' +
      '{"sku":"1068111","name":"Duracell batteries AA","brand":"Duracell","quantity":2,"inStock":false,' +
      '"productUrl":"/p/duracell/1068111","currency":"KD","price":4}</script></div>';
    const hits = asterHits(html, "vichy serum");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "Vichy Dercos Serum 90ml & more",
      merchant: "Aster Pharmacy",
      country: "KW",
      brand: "Vichy",
      price: 7.4,
      wasPrice: 9.9,
      currency: "KD",
      url: "https://www.myaster.com/p/vichy-serum/1068110",
      inStock: true,
    });
  });

  it("nahdiHits pairs price-anchor records with nearest names both directions", () => {
    // Record shapes measured live 2026-09-09 off the ar-sa search hop: the
    // bilingual payload puts names either before the price object (with a
    // trailing strike price) or after it; the sku rides whichever side. The
    // scanner must take the LATIN title nearest each price anchor and keep
    // each record's own sku — no bleeding across neighbours.
    const html =
      '<script>{"name":"صيدلية النهدي","seoName":"Nahdi Pharmacy United","items":[' +
      '{"name":"Nescafe Classic Coffee 200g","name_ar":"نسكافي كلاسيك","categoryIds":["8"],' +
      '"price":{"SAR":{"default":2.25,"default_formated":"2.25 ر س","default_original_formated":"3.00 ر س"}},' +
      '"sku":"103830664"},' +
      '{"sku":"103635949","brand":"NESCAFE","is_out_of_stock":"No","display_flag":true,' +
      '"price":{"SAR":{"default":4,"default_formated":"4.00"}},"name":"NESCAFE Classic Coffee Jar 100g",' +
      '"keyword_enrichment":{"arabic":["نسكافي"]}}]}</script>';
    const hits = nahdiHits(html, "nescafe coffee");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      title: "Nescafe Classic Coffee 200g",
      merchant: "Nahdi",
      country: "KW",
      price: 2.25,
      wasPrice: 3,
      currency: "SAR",
      url: "https://ecombe.nahdionline.com/ar/103830664",
      inStock: true,
    });
    expect(hits[1]).toMatchObject({
      title: "NESCAFE Classic Coffee Jar 100g",
      price: 4,
      currency: "SAR",
      url: "https://ecombe.nahdionline.com/ar/103635949",
    });
    expect(hits[1].wasPrice).toBeUndefined();
  });

  it("ounassHits keeps priced island records and skips label records", () => {
    // Measured shape off the working `/?q=` hop (2026-09-09): inline islands
    // pair a name with a numeric price and a categoryUrl; the shell's own
    // i18n labels ride the same keys with string prices and must not join.
    const html =
      '<script>{"contentTypeId":"shelf","name":"Nescafe Classic Coffee 200g","price":2.5,' +
      '"categoryUrl":"women/gifts","analyticsId":"x1"},' +
      '{"name":"Nescafe Coffee Blend","price":"Price","categoryUrl":"women"}</script>';
    const hits = ounassHits(html, "nescafe coffee");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "Nescafe Classic Coffee 200g",
      merchant: "Ounass",
      country: "KW",
      price: 2.5,
      currency: "KWD",
      url: "https://kuwait.ounass.com/women/gifts",
      inStock: true,
    });
  });

  it("danubeHomeHits reads Algolia records with bilingual names and sale flags", () => {
    // Measured shape off the spree_products index hop (2026-09-09): bilingual
    // names with the Latin first, numeric price/original_price, on_sale as
    // the strike-price flag, url_en relative to the danube.sa host. Records
    // without a numeric price or without query coverage stay out.
    const payload = {
      hits: [
        {
          master_id: 58784,
          name_en: "iPhone 17 Pro Max Cosmic Orange",
          full_name_en: "Apple iPhone 17 Pro Max Cosmic Orange",
          full_name_ar: "ابل آيفون 17 برو ماكس",
          price: 6699,
          original_price: 6899,
          on_sale: true,
          url_en: "/en/products/iphone-17-pro-max-cosmic-orange",
          image: "https://d1c124wpoew66.cloudfront.net/spree/images/x.png",
        },
        {
          master_id: 58785,
          full_name_en: "Samsung The Frame 55",
          price: 3299,
          original_price: 3299,
          on_sale: false,
          url_en: "/en/products/samsung-frame",
        },
        { master_id: 58786, full_name_en: "Apple Care Bundle", price: 0, url_en: "/en/" },
      ],
    };
    const hits = danubeHomeHits(payload, "iphone 17 pro");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "Apple iPhone 17 Pro Max Cosmic Orange",
      merchant: "Danube Home",
      country: "KW",
      price: 6699,
      wasPrice: 6899,
      currency: "SAR",
      url: "https://danube.sa/en/products/iphone-17-pro-max-cosmic-orange",
      image: "https://d1c124wpoew66.cloudfront.net/spree/images/x.png",
      inStock: true,
    });
  });
});

describe("REEA-437 — cold-start zero gets one widened retry + honest empty state", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }
  const xciteEnvelope = (hits: Record<string, unknown>[]) => ({ results: [{ hits }] });
  const xciteQuery = (init?: RequestInit): string => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      requests?: { params?: { query?: string } }[];
    };
    return body.requests?.[0]?.params?.query ?? "";
  };

  it("widerQuery trims one trailing token; single-token codes keep their form", () => {
    expect(widerQuery("iPhone 17 Pro")).toBe("iPhone 17");
    expect(widerQuery("WH-1000XM6")).toBe("WH-1000XM6");
    expect(widerQuery("  lg   gram  ")).toBe("lg");
  });

  it("a zero whole-query answer gets one trimmed-token retry whose live hits become the served cards", async () => {
    resetDiscoveryCache();
    const queries: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const query = xciteQuery(init);
      queries.push(query);
      // The whole phrase answers thin on the cold hop; the widened form
      // carries the real listings (the REEA-357 near-exact-match quirk).
      if (query === "lg gram mini") return jsonResponse(xciteEnvelope([]));
      if (query === "lg gram") {
        return jsonResponse(
          xciteEnvelope([
            { name: "LG gram 16 Notebook", slug: "lg16", price: 299, currency: "KWD", inStock: true },
          ]),
        );
      }
      return jsonResponse({});
    };

    const { products, notes, attemptedQueries } = await collectLiveResults("lg gram mini", { fetchImpl });

    // The widened retry's LIVE hits are the served answer — the page never
    // shows its own zero while a broader live fetch still had cards.
    expect(products.length).toBeGreaterThan(0);
    expect(products[0].title).toContain("LG gram");
    // The zero path names BOTH forms the run actually issued.
    expect(attemptedQueries).toEqual(["lg gram mini", "lg gram"]);
    // Coverage honesty: Xcite's answering retry note replaces its round-one zero.
    expect(notes.find((n) => n.merchant === "Xcite")?.hits).toBe(1);
    // One widening round only: the whole phrase runs at most once more than
    // the trimmed form, which never re-widens itself.
    const wholeRuns = queries.filter((q) => q === "lg gram mini").length;
    const wideRuns = queries.filter((q) => q === "lg gram").length;
    expect(wideRuns).toBeGreaterThanOrEqual(1);
    expect(wholeRuns - wideRuns).toBeLessThanOrEqual(1);
  });

  it("a single-token model code keeps its form and still gets its one bounded second attempt", async () => {
    resetDiscoveryCache();
    let xciteCalls = 0;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (xciteQuery(init) !== "WH-1000XM6") return jsonResponse({});
      xciteCalls++;
      // Cold first hop comes back thin (handshake/discovery window); the
      // second bounded attempt behind warmed hop caches answers fine — the
      // measured cold-first-load shape of the curated chips.
      if (xciteCalls === 1) return jsonResponse(xciteEnvelope([]));
      return jsonResponse(
        xciteEnvelope([
          { name: "Sony WH-1000XM6 Wireless Headphones", slug: "xm6", price: 74.9, currency: "KWD", inStock: true },
        ]),
      );
    };

    const { products, attemptedQueries } = await collectLiveResults("WH-1000XM6", { fetchImpl });

    expect(xciteCalls).toBe(2);
    expect(products.length).toBeGreaterThan(0);
    expect(products.some((p) => /WH-1000XM6/i.test(p.title))).toBe(true);
    // Single token: the widening IS the retry — one form, named once.
    expect(attemptedQueries).toEqual(["WH-1000XM6"]);
  });

  it("zero after the widened retry stays a real zero — one bounded retry, nothing invented", async () => {
    resetDiscoveryCache();
    const queries: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      queries.push(xciteQuery(init));
      return jsonResponse(xciteEnvelope([]));
    };

    const { products, attemptedQueries } = await collectLiveResults("zzxwq kvqpl", { fetchImpl });

    expect(products).toHaveLength(0);
    // The whole phrase answered once; the widened form answered once; done.
    expect(attemptedQueries).toEqual(["zzxwq kvqpl", "zzxwq"]);
    expect(queries.filter((q) => q === "zzxwq kvqpl").length).toBeLessThanOrEqual(2);
  });
});

describe("coverage order parity (REEA-437 split)", () => {
  it("COVERAGE_ORDER mirrors the COLLECTORS declaration order exactly", () => {
    // coverage.ts keeps a plain name list so the browser bundle never needs
    // the COLLECTORS object graph; this pins the list to the real adapter
    // order, so adding or reordering an adapter cannot silently desync the
    // coverage sentence from the REEA-254 determinism contract.
    expect([...COVERAGE_ORDER]).toEqual(COLLECTORS.map((c) => c.merchant));
  });
});

describe("REEA-486 grouped offer cards — one card per product identity", () => {
  it("`iPhone 17 Pro` shows one Pro card, one Pro Max card, the case after them", () => {
    // The exact shape from the brief: five near-duplicate listings for two
    // devices plus a case. The Japanese-Version tails fold onto their own
    // line (eSIM / plain), never onto a sibling model and never away from
    // the row they label.
    const products = groupHits("iPhone 17 Pro", [
      hit({ title: "Apple iPhone 17 Pro - Japanese Version (eSIM)", merchant: "Eureka", price: 429.9, url: "https://eureka.example/17p-jp", collectedAt: "2026-09-10T08:00:02.000Z" }),
      hit({ title: "Apple iPhone 17 Pro Silicone Case", merchant: "Blink", price: 12.9, url: "https://blink.example/case" }),
      hit({ title: "Apple iPhone 17 Pro Max - Japanese Version", merchant: "Jarir", country: "SA", currency: "SAR", price: 1900, url: "https://jarir.example/17pm-jp", collectedAt: "2026-09-10T08:00:03.000Z" }),
      hit({ title: "Apple iPhone 17 Pro Max - eSIM", merchant: "Xcite", price: 489.9, url: "https://xcite.example/17pm", collectedAt: "2026-09-10T08:00:01.000Z" }),
      hit({ title: "Apple iPhone 17 Pro - eSIM", merchant: "Xcite", price: 449.9, url: "https://xcite.example/17p", collectedAt: "2026-09-10T08:00:01.000Z" }),
    ]);
    expect(products).toHaveLength(3);
    // Pro and Pro Max keep their own cards; the case keeps its own and
    // renders AFTER the devices (Devices/Accessories tiering, REEA-189).
    const tier = partitionForQuery(products);
    expect(tier.tiered).toBe(true);
    expect(tier.devices.map((p) => p.title)).toEqual([
      // Non-extended model match leads its extension (REEA-213), and each
      // card shows its shortest member title — the qualifier survives below
      // it, on the row it labels.
      "Apple iPhone 17 Pro - eSIM",
      "Apple iPhone 17 Pro Max - eSIM",
    ]);
    expect(tier.accessories.map((p) => p.title)).toEqual(["Apple iPhone 17 Pro Silicone Case"]);

    // One Pro card: both spellings merged, every retailer that carries it.
    const pro = tier.devices.find((p) => !p.title.includes("Max"))!;
    expect(pro.offers.map((o) => `${o.merchant}:${o.price}`)).toEqual(["Eureka:429.9", "Xcite:449.9"]);
    // The qualifier survives inside the card on the row it labels …
    expect(pro.offers.find((o) => o.merchant === "Eureka")?.label).toBe("Japanese Version");
    // … and the plain listing keeps no label; both rows carry their hop stamp.
    expect(pro.offers.find((o) => o.merchant === "Xcite")?.label).toBeUndefined();
    expect(pro.offers.find((o) => o.merchant === "Eureka")?.collectedAt).toBe("2026-09-10T08:00:02.000Z");
    expect(pro.offers.every((o) => typeof o.collectedAt === "string")).toBe(true);

    // Pro Max card: same fold on its own line, case never joins a phone card.
    const max = tier.devices.find((p) => p.title.includes("Max"))!;
    expect(max.offers.map((o) => o.merchant).sort()).toEqual(["Jarir", "Xcite"]);
    expect(tier.accessories[0].offers.map((o) => o.merchant)).toEqual(["Blink"]);
  });

  it("Arabic locale mirrors the structure exactly (AC-5)", () => {
    const products = groupHits("آيفون 17 برو", [
      hit({ title: "آيفون 17 برو - نسخة يابانية (eSIM)", merchant: "Jarir", country: "SA", currency: "SAR", price: 1550, url: "https://jarir.example/ar-jp" }),
      hit({ title: "آيفون 17 برو (eSIM)", merchant: "Jarir", country: "SA", currency: "SAR", price: 1500, url: "https://jarir.example/ar" }),
    ]);
    expect(products).toHaveLength(1);
    const card = products[0];
    // Same two distinct listings, labels mirroring the Arabic tail.
    expect(card.offers.map((o) => `${o.price}:${o.label ?? ""}`)).toEqual([
      "1500:",
      "1550:نسخة يابانية",
    ]);
    // Max keeps its own card in Arabic too.
    const withMax = groupHits("آيفون 17 برو", [
      hit({ title: "آيفون 17 برو ماكس", merchant: "Jarir", country: "SA", currency: "SAR", price: 1700, url: "https://jarir.example/ar-max" }),
      hit({ title: "آيفون 17 برو", merchant: "Jarir", country: "SA", currency: "SAR", price: 1500, url: "https://jarir.example/ar" }),
    ]);
    expect(withMax).toHaveLength(2);
  });

  it("live chain stamps each retailer row with its own collected-at (AC-2/AC-4)", async () => {
    resetDiscoveryCache();
    function jsonResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    // Xcite answers with the two Pro spellings, Blink with the plain one:
    // one card per model must come out of the REAL chain (collectSettled →
    // groupHits), every row carrying its hop stamp so later retailer stages
    // append rows to the SAME grouped card instead of forking it.
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("xcite.com")) {
        return jsonResponse({
          results: [
            {
              hits: [
                { name: "Apple iPhone 17 Pro - Japanese Version (eSIM)", slug: "jp", price: 105, currency: "KWD", inStock: true },
                { name: "Apple iPhone 17 Pro - eSIM", slug: "eu", price: 110, currency: "KWD", inStock: true },
              ],
            },
          ],
        });
      }
      // Blink is the only merchant whose hop is this suggest.json shape;
      // every other retailer answers the empty object, so the card carries
      // exactly the two stubbed merchants.
      if (url.includes("blink.com.kw")) {
        return jsonResponse({ products: [{ title: "Apple iPhone 17 Pro - eSIM", handle: "p1", variants: [{ price: "99", available: true }] }] });
      }
      return new Response("{}");
    };
    const { products } = await collectLiveResults("iphone 17 pro", { fetchImpl });
    const proCards = products.filter((p) => p.title.includes("iPhone 17 Pro") && !p.title.includes("Max"));
    expect(proCards).toHaveLength(1);
    const rows = proCards[0].offers;
    // Both retailers on the one Pro card; the qualifier rides the row it
    // labels, and Xcite's two distinct listings keep their own rows.
    expect(rows.map((o) => `${o.merchant}:${o.price}`)).toEqual([
      "Blink:99",
      "Xcite:105",
      "Xcite:110",
    ]);
    expect(rows.every((o) => typeof o.collectedAt === "string")).toBe(true);
    const xciteRow = rows.find((o) => o.merchant === "Xcite")!;
    expect(xciteRow.label).toBe("Japanese Version");
  });
});
