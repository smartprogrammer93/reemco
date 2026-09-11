/**
 * REEA-376 — bounded response-size cap on the shared fetch paths.
 *
 * The regression that matters: an oversized fake upstream body must hit the
 * bounded error path (the cap note) instead of coming back as a full buffered
 * string — through the shared helper AND through every shared entry point
 * that consumes it (scraper.fetchWithTimeout, the search-fallback hop via
 * searchRetailerFallback, the live-search hop via collectLiveResults). The
 * api/health funnel hop shares readBodyCapped's `until` short-circuit, so the
 * helper-level cases below cover its shell-first shape too.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_BODY_BYTES, readBodyCapped } from "@/lib/collect/read-body";
import { fetchWithTimeout } from "@/lib/collect/scraper";
import { searchRetailerFallback } from "@/lib/collect/search-fallback";
import { collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

const BIG = "x".repeat(MAX_RESPONSE_BODY_BYTES + 1024);
const CAP_NOTE = /byte cap/;

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readBodyCapped (REEA-376 shared helper)", () => {
  it("returns documents whole under the cap", async () => {
    const html = await readBodyCapped(new Response("<html>ok</html>"));
    expect(html).toBe("<html>ok</html>");
  });

  it("aborts an oversized streamed body with the cap note instead of buffering it whole", async () => {
    // Four 700 KB chunks: every individual flush stays under the cap, only
    // the accumulated size crosses it — the read must still bail out.
    const res = streamedResponse(["a".repeat(700_000), "b".repeat(700_000), "c".repeat(700_000), "d".repeat(700_000)]);
    await expect(readBodyCapped(res)).rejects.toThrow(CAP_NOTE);
  });

  it("honours a tighter caller cap on the same path", async () => {
    await expect(readBodyCapped(new Response("x".repeat(64)), 32)).rejects.toThrow(CAP_NOTE);
    await expect(readBodyCapped(new Response("x".repeat(16)), 32)).resolves.toBe("x".repeat(16));
  });

  it("stops at the first flush that satisfies `until` and never reads the staged tail", async () => {
    // The health funnel's shell-first shape: the first flush carries the
    // assertion input, the rest of the staged document is cancelled.
    const res = streamedResponse(["FIRST-FLUSH-MARKER", "TAIL-SECOND-FLUSH"]);
    const html = await readBodyCapped(res, MAX_RESPONSE_BODY_BYTES, (h) => h.includes("FIRST-FLUSH-MARKER"));
    expect(html).toBe("FIRST-FLUSH-MARKER");
  });

  it("enforces the cap on non-streaming response fakes too", async () => {
    // Minimal doubles hand us a body-less Response; the fallback branch must
    // still take the bounded error path rather than return the whole string.
    const oversized = { body: null, text: async () => BIG } as unknown as Response;
    await expect(readBodyCapped(oversized)).rejects.toThrow(CAP_NOTE);
    const small = { body: null, text: async () => "ok" } as unknown as Response;
    await expect(readBodyCapped(small)).resolves.toBe("ok");
  });
});

describe("scraper.fetchWithTimeout shares the bounded read", () => {
  it("hands back the cap note for an oversized page instead of the full string", async () => {
    const fetchImpl = async () => new Response(BIG);
    await expect(fetchWithTimeout("https://retailer.example/p/1", 2000, fetchImpl)).rejects.toThrow(CAP_NOTE);
  });

  it("still returns normal documents whole", async () => {
    const fetchImpl = async () => new Response('<html><title>Sony WH-1000XM6</title></html>');
    const html = await fetchWithTimeout("https://retailer.example/p/1", 2000, fetchImpl);
    expect(html).toContain("Sony WH-1000XM6");
  });
});

describe("search-fallback hops read through the cap (via searchRetailerFallback)", () => {
  const PRODUCT = "Sony WH-1000XM6 Wireless Noise Cancelling Headphones";
  const shopifyPayload = {
    products: [
      {
        title: PRODUCT,
        handle: "sony-wh-1000xm6-black",
        variants: [{ price: "149.900", available: true }],
      },
    ],
  };

  it("a bounded Shopify answer still resolves through the buffered view", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(shopifyPayload), { headers: { "content-type": "application/json" } });
    const found = await searchRetailerFallback("blink.com.kw", PRODUCT, fetchImpl);
    expect(found.price).toBeCloseTo(149.9);
    expect(found.url).toBe("https://blink.com.kw/products/sony-wh-1000xm6-black");
  });

  it("an oversized Shopify answer takes the cap note, not a full-string parse", async () => {
    const fetchImpl = async () => new Response(BIG);
    await expect(searchRetailerFallback("blink.com.kw", PRODUCT, fetchImpl)).rejects.toThrow(CAP_NOTE);
  });
});

describe("live-search hops read through the cap (via collectLiveResults)", () => {
  it("an oversized retailer answer becomes that hop's error note; the other lanes still render", async () => {
    resetDiscoveryCache();
    const { notes } = await collectLiveResults("dell laptop", {
      fetchImpl: async (url) => {
        if (url.includes("xcite.com/api/algolia/proxy")) {
          // Fat Algolia envelope: bigger than the cap, must never be buffered.
          return new Response("x".repeat(MAX_RESPONSE_BODY_BYTES + 1024));
        }
        if (url.includes("wp-json/wc/store/v1/products")) {
          return new Response(
            JSON.stringify([
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
            ]),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}");
      },
    });
    // Graceful degradation: one oversized hop degrades its own note only.
    const xcite = notes.find((n) => n.merchant === "Xcite");
    expect(xcite?.error).toMatch(CAP_NOTE);
    const pckuwait = notes.find((n) => n.merchant === "PC Kuwait");
    expect(pckuwait?.error).toBeUndefined();
    expect(pckuwait?.hits).toBeGreaterThan(0);
  });
});
