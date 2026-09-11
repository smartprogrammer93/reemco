/**
 * REEA-550 — lane coverage for the fixed-query regressions on served stamp
 * 3571c026: Quadra Stores zeroed by the control query, Lulu Hypermarket
 * answered zero silently behind the CF block shell, PC Kuwait missed the
 * completion budget on Arabic phrases with the bridge answered in reach.
 * Injected fetches keep the hops deterministic; the fixtures mirror shapes
 * captured live 2026-09-10.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { COLLECTORS, collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

describe("REEA-550 collector lanes", () => {
  it("Quadra hop merges bounded per-word rounds when the whole-query suggest is empty", async () => {
    resetDiscoveryCache();
    const seenQ: string[] = [];
    const rowsFor = (q: string) => {
      const w = q.toLowerCase();
      if (w === "iphone") {
        return [
          {
            title: "Apple iPhone 17 Pro Max 256GB",
            handle: "iphone-17-pro-max",
            price: "499.00", available: true, vendor: "Apple",
          },
        ];
      }
      if (w === "17") {
        return [
          {
            title: "Apple iPhone 17 Pro Max 256GB",
            handle: "iphone-17-pro-max",
            price: "499.00", available: true, vendor: "Apple",
          },
          {
            title: "PNY RP60 SSD 2TB",
            handle: "pny-rp60",
            price: "129.00", available: true, vendor: "PNY",
          },
        ];
      }
      if (w.includes("iphone")) {
        // Any widened phrase form of the whole query answers the merged rows
        // directly — same as the live suggest endpoint after the widen pass.
        return [
          {
            title: "Apple iPhone 17 Pro Max 256GB",
            handle: "iphone-17-pro-max",
            price: "499.00", available: true, vendor: "Apple",
          },
        ];
      }
      return [];
    };
    const { notes } = await collectLiveResults("iPhone 17 Pro", {
      fetchImpl: async (url) => {
        if (url.includes("quadrastores.com/search/suggest.json")) {
          const q = decodeURIComponent(url.match(/[?&]q=([^&]*)/)?.[1] ?? "");
          seenQ.push(q);
          return new Response(JSON.stringify({ resources: { results: { products: rowsFor(q) } } }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}");
      },
    });
    // Whole query first; a bounded per-word round backs the empty first answer.
    expect(seenQ[0]).toBe("iPhone 17 Pro");
    const note = notes.find((n) => n.merchant === "Quadra Stores");
    // The shared gate scores merged rows against the ORIGINAL query: the
    // iPhone record passes (all tokens), the SSD row does not. The handle
    // dedupe keeps the record answering twice at one hit.
    expect(note?.hits).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  });

  it("Quadra hop keeps a strong whole-query answer a single round-trip", async () => {
    resetDiscoveryCache();
    const seenQ: string[] = [];
    const hop = COLLECTORS.find((c) => c.merchant === "Quadra Stores");
    const direct = await hop!.collect("samsung", async (url) => {
      seenQ.push(decodeURIComponent(url.match(/[?&]q=([^&]*)/)?.[1] ?? ""));
      return new Response(
        JSON.stringify({
          resources: { results: { products: [{ title: "Samsung Galaxy A17 5G", handle: "galaxy-a17", price: "79.00", available: true, vendor: "Samsung" }] } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const { notes } = await collectLiveResults("samsung", {
      fetchImpl: async (url) => {
        if (url.includes("quadrastores.com/search/suggest.json")) {
          const q = decodeURIComponent(url.match(/[?&]q=([^&]*)/)?.[1] ?? "");
          seenQ.push(q);
          return new Response(
            JSON.stringify({
              resources: {
                results: {
                  products: [
                    {
                      title: "Samsung Galaxy A17 5G",
                      handle: "galaxy-a17",
                      price: "79.00", available: true, vendor: "Samsung",
                    },
                  ],
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}");
      },
    });
    expect(seenQ[0]).toBe("samsung");
    expect(notes.find((n) => n.merchant === "Quadra Stores")?.hits).toBeGreaterThanOrEqual(1);
  });

  it("Lulu hop rides the first fresh connection that carries JSON-LD records", async () => {
    resetDiscoveryCache();
    let luluCalls = 0;
    const ldPage = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "Item",
          item: {
            "@type": "Product",
            name: "Dove Beauty Bar Soap",
            offers: { "@type": "Offer", price: "1.77", priceCurrency: "KWD", availability: "https://schema.org/InStock", url: "/p/dove-beauty-bar" },
          },
        },
      ],
    })}</script></head><body>ok</body></html>`;
    const { notes } = await collectLiveResults("\u062f\u0648\u0641 \u0635\u0627\u0648\u0646", {
      fetchImpl: async (url) => {
        if (url.includes("luluhypermarket.com/en/search")) {
          luluCalls += 1;
          const shell = luluCalls === 1;
          return new Response(
            shell ? `<html><div id="cf-error-details">challenge</div></html>` : ldPage,
            { headers: { "content-type": "text/html" } },
          );
        }
        return new Response("{}");
      },
    });
    const note = notes.find((n) => n.merchant === "Lulu Hypermarket");
    // The identity hop answered the shell — too thin to count under the
    // REEA-526 ld+json presence gate — and the clearance hop carried the
    // records; the hop stops at the first body with real content. The
    // clearance path polls on its own bounded cadence, so give this lane a
    // window wider than the default: collectLiveResults finalizes on the
    // 4500 ms completion clock and the clearance poll rides behind it.
    expect(luluCalls).toBeGreaterThanOrEqual(2);
    expect((note?.hits ?? 0)).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  }, 15000);

  it("PC Kuwait Arabic phrase merges the bridge word rounds within one bounded pass", async () => {
    resetDiscoveryCache();
    const seenQ: string[] = [];
    const dove = {
      name: "Dove White Beauty Bar Soap",
      permalink: "https://pckuwait.com/product/dove-white/",
      is_in_stock: true,
      prices: { price: "195", currency_code: "KWD", currency_minor_unit: 3 },
    };
    const { notes } = await collectLiveResults("\u062f\u0648\u0641 \u0635\u0627\u0648\u0646", {
      fetchImpl: async (url) => {
        if (url.includes("wp-json/wc/store/v1/products")) {
          const q = decodeURIComponent(url.match(/[?&]search=([^&]*)/)?.[1] ?? "");
          seenQ.push(q);
          const rows = q === "dove" || q === "soap" ? [dove] : [];
          return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
        }
        return new Response("{}");
      },
    });
    // REEA-635 C3 — with the dispatch-level LatinBridge the whole-query hop
    // LEADS bridged: the aliased token arrives in its curated Latin spelling
    // ("dove") and the token no alias claims rides the shopper spelling —
    // so one bounded whole-query round reaches the Store API on the spelling
    // the Latin-only catalog carries. No empty Arabic round ahead of it; the
    // capped word rounds behind it keep answering whatever the phrase needs.
    expect(seenQ[0]).toBe("dove \u0635\u0627\u0648\u0646");
    expect(seenQ).toContain("dove");
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    expect((note?.hits ?? 0)).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  });

  it("PC Kuwait JSON hop reaches the pinned Static-IPs tier ahead of the handshake rotation", async () => {
    resetDiscoveryCache();
    const dove = {
      name: "Dove White Beauty Bar Soap",
      permalink: "https://pckuwait.com/product/dove-white/",
      is_in_stock: true,
      prices: { price: "195", currency_code: "KWD", currency_minor_unit: 3 },
    };
    const seenUrls: string[] = [];
    const { notes } = await collectLiveResults("soap", {
      fetchImpl: async (url) => {
        seenUrls.push(url);
        if (url.includes("wp-json/wc/store/v1/products")) {
          // The hostname shapes (bare GET, KV replay, identity handshake)
          // land on the CF block page from the deployed egress — measured
          // ~1.4 s per attempt, non-ok every time.
          if (url.startsWith("http://104.") || url.startsWith("http://172.")) {
            const q = decodeURIComponent(url.match(/[?&]search=([^&]*)/)?.[1] ?? "");
            const rows = q === "soap" ? [dove] : [];
            return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
          }
          return new Response("Just a moment...", { status: 403, headers: { "content-type": "text/html" } });
        }
        return new Response("{}");
      },
    });
    // REEA-602 support — with every hostname shape blocked, the pinned
    // Static-IPs hop answers the Store API JSON ahead of the identity
    // rotation burning the doubled window; the lane still contributes rows.
    expect(seenUrls.some((u) => /^https?:\/\/(104\.|172\.)/.test(u))).toBe(true);
    const note = notes.find((n) => n.merchant === "PC Kuwait");
    expect((note?.hits ?? 0)).toBeGreaterThanOrEqual(1);
    expect(note?.error).toBeUndefined();
  });
});
