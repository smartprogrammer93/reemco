import { test } from "vitest";
import assert from "node:assert/strict";
import { searchProducts, suggestProducts } from "@/lib/search";
import { PRODUCTS } from "@/lib/feed";
import { effectivePrice } from "@/lib/format";

test("effectivePrice applies dollar-off coupons", () => {
  assert.equal(effectivePrice({ price: 42.5 } as never, { code: "S5", discount: "$5 off" }), 37.5);
});

test("effectivePrice applies percent-off coupons", () => {
  assert.ok(
    Math.abs(
      (effectivePrice({ price: 42.5 } as never, { code: "P10", discount: "10% off" }) ?? 0) - 38.25,
    ) < 1e-9,
  );
});

test("effectivePrice returns null for unparsable or absent coupons", () => {
  assert.equal(effectivePrice({ price: 10 } as never, { code: null, discount: "bundle deal" }), null);
  assert.equal(effectivePrice({ price: 10 } as never, undefined), null);
});

test("exact product name matches", () => {
  const r = searchProducts("ASUS ROG Strix Scope II", PRODUCTS);
  assert.ok(r.length > 0);
  assert.equal(r[0].product.productId, "asus-rog-strix-scope-ii");
});

test("user's reported query class: extra unknown tokens still match", () => {
  const r = searchProducts("ASUS XA14 ROG Strix Scope II X", PRODUCTS);
  assert.ok(r.length > 0);
  assert.equal(r[0].product.productId, "asus-rog-strix-scope-ii");
});

test("typo tolerance (edit distance 1)", () => {
  const r = searchProducts("Stirx Scope", PRODUCTS);
  assert.ok(r.some((m) => m.product.productId === "asus-rog-strix-scope-ii"));
});

test("partial tokens: brand-only query", () => {
  const r = searchProducts("sony", PRODUCTS);
  assert.ok(r.length >= 2);
});

test("gibberish returns nothing", () => {
  assert.equal(searchProducts("zzzqqq wxyz", PRODUCTS).length, 0);
});

test("empty query returns full catalog", () => {
  assert.equal(searchProducts("", PRODUCTS).length, PRODUCTS.length);
});

test("suggestions recover nearest match for unmatched query", () => {
  const s = suggestProducts("zzzqqq sony headphone", PRODUCTS);
  assert.ok(s.length > 0);
  assert.ok(s.some((m) => m.product.brand === "Sony"));
});

test("all catalog records are well-formed", () => {
  for (const p of PRODUCTS) {
    assert.ok(p.productId && p.title && p.brand);
    assert.ok(p.offers.length > 0);
    assert.ok(Array.isArray(p.coupons));
    assert.ok(Array.isArray(p.variations));
    assert.ok(Array.isArray(p.alternatives));
  }
});
