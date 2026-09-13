/**
 * REEA-896 — product-page collected offers rendered fils amounts as KD.
 *
 * QA evidence (REEA-889 E2E smoke, stamp c93006c3bcc8): on
 * /product/apple-iphone-17-pro-max-esim the collection panel showed Zayoom
 * KD 37,990 / KD 39,990, Blink KD 36,490 / KD 36,900, Astore KD 39,700 —
 * exactly 100x the prices the /search path renders for the same retailers
 * (Zayoom 379.900, Blink 369.000, Astore 397.000/408.000) — and the savings
 * pill computed "Save KD 39,290.10" against the mis-scaled figure.
 *
 * Root cause: extractPrice's "JSON-LD" step was never scoped to JSON-LD — it
 * ran one regex over the WHOLE document and matched the Shopify theme's
 * inline variant array first, where `price` is a minor-unit integer
 * (`"price":37990`). The same pages carry the correct signals: an
 * og:price:amount meta stamped from the URL's canonical variant (equal to
 * the suggest.json price the /search adapters render, verified live on
 * zayoom/blink/astore/quadra/switch/wibi) and a real application/ld+json
 * Product record. Fix: structured reads first (meta with a currency guard,
 * then parsed JSON-LD Product/Offer blocks with a priceCurrency guard), the
 * legacy whole-document scan kept verbatim as the last resort so pages with
 * neither structured signal behave exactly as before.
 *
 * Guardrails encoded here:
 *  - the Shopify mis-scale shape (inline minor-unit integer BEFORE the
 *    structured records) now lands on the meta/JSON-LD price, not the raw
 *    integer — Zayoom, Blink and Astore live shapes pinned below;
 *  - Blink's multi-variant Product JSON-LD (first offer is a DIFFERENT
 *    variant than the URL's canonical one) pins meta-first precedence;
 *  - pages with only the legacy signals keep the pre-896 result;
 *  - a structured record stamped in another currency is skipped, never
 *    taken as the page price.
 */
import { describe, expect, it } from "vitest";
import { extractPrice, scrapeOffer } from "@/lib/collect/scraper";

/** Zayoom PDP shape (live 2026-09-13): theme JS ships minor-unit integers
 *  long before the Product JSON-LD and the og:price meta. */
const ZAYOOM_SHAPE = `
<html><head>
<meta property="og:price:amount" content="379.90">
<meta property="og:price:currency" content="KWD">
</head><body>
<script>window.__PRELOADED__ = {"variants":[{"id":1,"price":37990,"available":true}]};</script>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Organization","name":"Zayoom"}</script>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Product","name":"Apple iPhone 17 Pro Max","offers":{"@type":"Offer","availability":"http://schema.org/InStock","price":"379.900","priceCurrency":"KWD"}}</script>
</body></html>`;

/** Blink PDP shape: Product JSON-LD lists EVERY variant offer; the first
 *  entry (389.0) is not the URL's canonical variant — the og meta (369.00)
 *  is. Theme JS still carries the minor-unit integer first. */
const BLINK_SHAPE = `
<html><head>
<meta property="og:price:amount" content="369.00">
<meta property="og:price:currency" content="KWD">
</head><body>
<script>var meta = {"variants":[{"price":36900}]};</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","offers":[{"@type":"Offer","name":"256 GB / Silver","price":389.0,"priceCurrency":"KWD"},{"@type":"Offer","name":"128 GB","price":369.0,"priceCurrency":"KWD"}]}</script>
</body></html>`;

/** Astore PDP shape: minor-unit integer in theme JS, Product JSON-LD with a
 *  numeric 3-decimal-capable price and no og currency meta. */
const ASTORE_SHAPE = `
<html><head><meta property="og:price:amount" content="408.00"></head><body>
<script>var v = {"price":40800};</script>
<script type="application/ld+json">{"@type":"Product","offers":[{"@type":"Offer","price":408.0,"priceCurrency":"KWD"}]}</script>
</body></html>`;

describe("REEA-896 extractPrice structured-first precedence", () => {
  it("reads the meta/JSON-LD price on the Zayoom mis-scale shape (was 37990)", () => {
    expect(extractPrice(ZAYOOM_SHAPE, "KWD")).toBe(379.9);
  });

  it("prefers the URL's canonical meta price over the first JSON-LD variant offer (Blink)", () => {
    expect(extractPrice(BLINK_SHAPE, "KWD")).toBe(369);
  });

  it("keeps the Astore shape on the og meta (408, not 40800)", () => {
    expect(extractPrice(ASTORE_SHAPE, "KWD")).toBe(408);
  });

  it("falls back to the parsed JSON-LD Product price when no meta exists", () => {
    const html = ZAYOOM_SHAPE.replace(/<meta[^>]+>/g, "");
    expect(extractPrice(html, "KWD")).toBe(379.9);
  });

  it("keeps the legacy whole-document scan when no structured signal exists", () => {
    const html = `<div data-x>{"price": 12.34}</div><span>19.900</span>`;
    expect(extractPrice(html)).toBe(12.34);
  });

  it("rejects a meta price stamped in another currency and falls through", () => {
    const html = `
      <meta property="og:price:amount" content="55.00">
      <meta property="og:price:currency" content="AED">
      <script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":12.5,"priceCurrency":"KWD"}}</script>`;
    expect(extractPrice(html, "KWD")).toBe(12.5);
  });

  it("rejects a JSON-LD record whose priceCurrency disagrees with the retailer's", () => {
    const html = `
      <script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":99,"priceCurrency":"SAR"}}</script>
      <script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":12.5,"priceCurrency":"KWD"}}</script>`;
    expect(extractPrice(html, "KWD")).toBe(12.5);
  });

  it("accepts the local KD spelling as KWD", () => {
    const html = `<script type="application/ld+json">{"@type":"Offer","price":7.25,"priceCurrency":"KD"}</script>`;
    expect(extractPrice(html, "KWD")).toBe(7.25);
  });

  it("accepts a 3-decimal KWD meta stamp (minor-currency storefront format)", () => {
    const html = `<meta property="og:price:amount" content="379.900">`;
    expect(extractPrice(html, "KWD")).toBe(379.9);
  });

  it("scrapeOffer end-to-end: the collected Zayoom offer carries 379.9, not 37990", async () => {
    const outcome = await scrapeOffer(
      {
        merchant: "Zayoom",
        url: "https://zayoom.com/products/apple-iphone-17-pro-max-256gb-silver-japanese",
        currency: "KWD",
      },
      {
        fetchImpl: async () =>
          new Response(ZAYOOM_SHAPE, { status: 200, headers: { "content-type": "text/html" } }),
      },
    );
    expect(outcome.offers).toHaveLength(1);
    expect(outcome.offers[0].price).toBe(379.9);
    expect(outcome.offers[0].currency).toBe("KWD");
  });
});
