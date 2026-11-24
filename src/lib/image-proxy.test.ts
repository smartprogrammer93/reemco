/**
 * REEA-1128 — retailer image delivery policy.
 *
 * The regression this pins: a Shopify product photo must NOT be handed to the
 * shopper's browser as a third-party hotlink (the live 403 → empty frame +
 * console error), while every other retailer image keeps its direct URL so
 * the CDNs that already answer correctly are untouched. The SSRF guard is the
 * public-facing half: `u` is a query parameter anyone can craft.
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_PROXY_ROUTE,
  isFetchableImageUrl,
  isProxiedImageSrc,
  proxiedImageSrc,
  shouldProxyImage,
} from "@/lib/image-proxy";

describe("REEA-1128 — proxy policy for the measured cold-miss host", () => {
  it("routes cdn.shopify.com through the same-origin proxy", () => {
    const src =
      "https://cdn.shopify.com/s/files/1/0677/2470/6005/files/JBL_Tune_780NC.jpg?v=1776607449";
    expect(shouldProxyImage(src)).toBe(true);
    const out = proxiedImageSrc(src);
    expect(out).toBe(`${IMAGE_PROXY_ROUTE}?u=${encodeURIComponent(src)}`);
    // The round trip is lossless: the route decodes the exact upstream URL.
    const decoded = decodeURIComponent(new URL(out as string, "https://x").searchParams.get("u") ?? "");
    expect(decoded).toBe(src);
  });

  it("covers a store-specific Shopify CDN hostname by suffix", () => {
    expect(shouldProxyImage("https://shop.cdn.shopify.com/s/files/a/b/c.jpg")).toBe(true);
    expect(shouldProxyImage("https://cdn.shopifycdn.com/store/1.jpg")).toBe(true);
  });

  it("leaves every other retailer image on its direct URL", () => {
    for (const src of [
      "https://d1c124wpoew66.cloudfront.net/spree/images/attachments/000/114/204/product/60605465.jpg",
      "https://www.jarir.com/media/catalog/product/xcite.jpg",
      "https://cdn.example/1.png",
    ]) {
      expect(shouldProxyImage(src)).toBe(false);
      expect(proxiedImageSrc(src)).toBe(src);
    }
  });

  it("never proxies a non-https or unparseable source", () => {
    expect(shouldProxyImage("http://cdn.shopify.com/s/files/a.jpg")).toBe(false);
    expect(shouldProxyImage("not a url")).toBe(false);
    expect(proxiedImageSrc("not a url")).toBe("not a url");
  });

  it("blank sources stay undefined so the card keeps its category glyph", () => {
    expect(proxiedImageSrc(undefined)).toBeUndefined();
    expect(proxiedImageSrc(null)).toBeUndefined();
    expect(proxiedImageSrc("   ")).toBeUndefined();
  });

  it("identifies the proxied URL so the card can pick the retrying image", () => {
    const shopify = "https://cdn.shopify.com/s/files/1/a.jpg?v=1";
    expect(isProxiedImageSrc(proxiedImageSrc(shopify))).toBe(true);
    expect(isProxiedImageSrc(proxiedImageSrc("https://cdn.example/1.png"))).toBe(false);
    expect(isProxiedImageSrc(undefined)).toBe(false);
    expect(isProxiedImageSrc("/api/image")).toBe(false);
  });
});

describe("REEA-1128 — SSRF guard for the public `u` parameter", () => {
  it("accepts public https image hosts", () => {
    expect(isFetchableImageUrl("https://cdn.shopify.com/s/files/1/a.jpg?v=1")).toBe(true);
    expect(isFetchableImageUrl("https://d1c124wpoew66.cloudfront.net/a.jpg")).toBe(true);
  });

  it("refuses non-https, loopback, container-network and metadata addresses", () => {
    for (const raw of [
      "http://cdn.shopify.com/a.jpg",
      "https://localhost/a.jpg",
      "https://app.localhost/a.jpg",
      "https://reemco.local/a.jpg",
      "https://db.internal/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://10.0.0.7/a.jpg",
      "https://172.20.1.4/a.jpg",
      "https://192.168.1.9/a.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a.jpg",
      "https://[fd00::1]/a.jpg",
      "intranet",
      "",
    ]) {
      expect(isFetchableImageUrl(raw), raw).toBe(false);
    }
  });

  it("keeps a public IPv4 literal", () => {
    expect(isFetchableImageUrl("https://8.8.8.8/logo.png")).toBe(true);
  });
});
