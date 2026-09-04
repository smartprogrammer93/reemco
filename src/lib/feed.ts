import type { NormalizedProduct } from "@/types/product";

/**
 * Stub data layer for the normalized feed.
 *
 * TODO(data-engineer): replace this module's data source with the
 * Scraping/Data Engineer's normalized feed (JSON file, API, or KV) while
 * keeping the return shapes identical.
 */

export const STUB_PRODUCTS: NormalizedProduct[] = [
  {
    productId: "stub-1",
    title: "Example Wireless Headphones",
    brand: "Acme",
    offers: [
      {
        merchant: "Store A",
        price: 99.0,
        currency: "USD",
        url: "https://example.com/a",
        inStock: true,
      },
      {
        merchant: "Store B",
        price: 89.99,
        currency: "USD",
        url: "https://example.com/b",
        inStock: false,
      },
    ],
    coupons: [
      {
        code: "SAVE10",
        description: "10% off first order",
        discount: "10% off",
        expiresAt: null,
      },
    ],
    variations: [
      { id: "v-black", label: "Black", priceDelta: 0 },
      { id: "v-white", label: "White", priceDelta: 5 },
    ],
    alternatives: [
      {
        productId: "stub-2",
        title: "Example Wired Headphones",
        fromPrice: 29.99,
      },
    ],
  },
];

export function filterProducts(
  products: NormalizedProduct[],
  query: string,
): NormalizedProduct[] {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter(
    (p) =>
      p.title.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q),
  );
}
