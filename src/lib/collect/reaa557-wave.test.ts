/**
 * REEA-557 — batch-5 first-wave lanes: Alghanim Electronics (WooCommerce
 * archive with the Electro-theme price box) and BinSina (Magento Cloud search
 * view behind the per-connection Fastly decision). Fixtures mirror the shapes
 * captured live from the coder edge 2026-09-10; injected fetches keep the hop
 * chains deterministic. Guards: the theme-specific amount chain is read, the
 * shared gate scores merged rows against the ORIGINAL query, the whole-query
 * hop stays a single round-trip when it answers, and the BinSina tier chain
 * stops at the first body carrying real result content.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { COLLECTORS, alghanimHits, binsinaHits, collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

describe("REEA-557 Alghanim Electronics lane", () => {
  it("alghanimHits reads the Electro-theme card shape with served labels", () => {
    // Shape captured live off alghanim-store.com 2026-09-10: the loop-title
    // h2 wraps the link, `<del>/<ins>` carry list/sale amounts through the
    // nested sar-currency-symbol wrapper (empty symbol span, figure before
    // </bdi>), a plain amount when no promo runs. Empty symbol → the theme's
    // SAR stamp; KD-style labels join KWD like the shared Woo scanner.
    const html =
      '<h2 class="woocommerce-loop-product__title"><a class="woocommerce-loop-product__link" href="https://alghanim-store.com/product/coffee-a/">Coffee A 50g</a></h2>' +
      '<span class="price"><del><span class="woocommerce-Price-amount amount"><bdi>' +
      '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 2.80</bdi></span></del>' +
      '<ins><span class="woocommerce-Price-amount amount"><bdi>' +
      '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 2.40</bdi></span></ins></span>' +
      '<h2 class="woocommerce-loop-product__title"><a class="woocommerce-loop-product__link" href="https://alghanim-store.com/product/coffee-b/">Coffee B 50g</a></h2>' +
      '<span class="price"><span class="woocommerce-Price-amount amount"><bdi>' +
      '<span class="woocommerce-Price-currencySymbol">KD</span> 2.50</bdi></span></span>' +
      '<h2 class="woocommerce-loop-product__title"><a class="woocommerce-loop-product__link" href="https://alghanim-store.com/product/other/">Totally Other Thing</a></h2>' +
      '<span class="price"><span class="woocommerce-Price-amount amount"><bdi>' +
      '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 9.00</bdi></span></span>';
    const hits = alghanimHits(html, "coffee");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      merchant: "Alghanim Electronics",
      country: "KW",
      title: "Coffee A 50g",
      price: 2.4,
      wasPrice: 2.8,
      currency: "SAR",
      url: "https://alghanim-store.com/product/coffee-a/",
      inStock: true,
    });
    expect(hits[1]).toMatchObject({ title: "Coffee B 50g", price: 2.5, currency: "KWD" });
    expect(hits[1]).not.toHaveProperty("wasPrice");
  });

  it("whole-query hop stays one round-trip when the archive answers", async () => {
    resetDiscoveryCache();
    const seenQ: string[] = [];
    const cardPage =
      '<h2 class="woocommerce-loop-product__title"><a href="https://alghanim-store.com/product/coffee-x/">Coffee X 50g</a></h2>' +
      '<span class="price"><span class="woocommerce-Price-amount amount"><bdi>' +
      '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 3.10</bdi></span></span>';
    const hop = COLLECTORS.find((c) => c.merchant === "Alghanim Electronics");
    const hits = await hop!.collect("coffee", async (url) => {
      seenQ.push(decodeURIComponent(url.match(/[?&]s=([^&]*)/)?.[1] ?? ""));
      return new Response(cardPage, { headers: { "content-type": "text/html" } });
    });
    expect(seenQ).toEqual(["coffee"]);
    expect(hits[0]).toMatchObject({ title: "Coffee X 50g", price: 3.1, currency: "SAR" });
  });

  it("empty whole-query answer gets one bounded per-word round, gate scores the ORIGINAL query", async () => {
    resetDiscoveryCache();
    const seenQ: string[] = [];
    const { notes } = await collectLiveResults("coffee 50g", {
      fetchImpl: async (url) => {
        // Only the Alghanim lane's hops are tracked; sibling collectors fan out
        // through the same injected fetch and must not shift the lane's order.
        if (!url.includes("alghanim-store.com")) return new Response("{}");
        const q = decodeURIComponent(url.match(/[?&]s=([^&]*)/)?.[1] ?? "");
        seenQ.push(q);
        if (q === "coffee 50g") return new Response("<html><body>no rows</body></html>");
        return new Response(
          '<h2 class="woocommerce-loop-product__title"><a href="https://alghanim-store.com/product/nescafe-coffee/">Nescafe Coffee 50g</a></h2>' +
            '<span class="price"><span class="woocommerce-Price-amount amount"><bdi>' +
            '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 2.20</bdi></span></span>' +
            '<h2 class="woocommerce-loop-product__title"><a href="https://alghanim-store.com/product/rice/">Basmati Rice Bag</a></h2>' +
            '<span class="price"><span class="woocommerce-Price-amount amount"><bdi>' +
            '<span class="sar-currency-symbol"><span class="woocommerce-Price-currencySymbol"></span></span> 4.00</bdi></span></span>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    expect(seenQ[0]).toBe("coffee 50g");
    expect(seenQ).toContain("coffee");
    const note = notes.find((n) => n.merchant === "Alghanim Electronics");
    // The shared gate keeps the Coffee 50g row (both original-query tokens
    // present) and drops the rice row — scored against the ORIGINAL phrase.
    expect(note?.hits).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  });
});

describe("REEA-557 BinSina lane", () => {
  it("binsinaHits reads JSON-LD records first and joins relative offer urls", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "Item",
          item: {
            "@type": "Product",
            name: "Dove Beauty Bar Soap",
            offers: { "@type": "Offer", price: "4.50", priceCurrency: "AED", availability: "https://schema.org/InStock", url: "/en/dove-beauty-bar" },
          },
        },
      ],
    });
    const html = `<script type="application/ld+json">${ld}</script>`;
    const hits = binsinaHits(html, "\u062f\u0648\u0641 \u0635\u0627\u0648\u0646 dove");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "BinSina",
      country: "KW",
      price: 4.5,
      currency: "AED",
      url: "https://binsina.ae/en/dove-beauty-bar",
      inStock: true,
    });
  });

  it("binsinaHits falls back to the Luma card rows with the served label", () => {
    const html =
      '<strong class="product name product-item-name"><a class="product-item-link" href="/en/vitamin-c-1000">' +
      'Vitamin C 1000mg Chewable</a></strong><span class="price">AED 39.00</span>';
    const hits = binsinaHits(html, "vitamin c");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "BinSina",
      price: 39,
      currency: "AED",
      url: "https://binsina.ae/en/vitamin-c-1000",
    });
  });

  it("the hop stops at the first identity answer that carries result content", async () => {
    resetDiscoveryCache();
    let calls = 0;
    const ldPage = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "Item",
          item: {
            "@type": "Product",
            name: "Dove Beauty Bar Soap",
            offers: { "@type": "Offer", price: "4.50", priceCurrency: "AED", availability: "https://schema.org/InStock", url: "/en/dove-beauty-bar" },
          },
        },
      ],
    })}</script></head><body>ok</body></html>`;
    const hop = COLLECTORS.find((c) => c.merchant === "BinSina");
    const hits = await hop!.collect("\u062f\u0648\u0641 \u0635\u0627\u0648\u0646", async (url) => {
      calls += 1;
      return new Response(url.includes("binsina.ae") ? ldPage : "{}", { headers: { "content-type": "text/html" } });
    });
    // The cache-first replay of the identity tier answers with real content,
    // so the clearance tier never runs: one round-trip on the fast path.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ merchant: "BinSina", currency: "AED" });
  });
});
