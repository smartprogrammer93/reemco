/**
 * REEA-1189 — one canonical URL per product.
 *
 * The sitemap names the stable catalog identities (`/product/iphone-17-pro`).
 * Live results, however, mint productIds from the retailer merge identity
 * (`apple-iphone17-pro-256gb`), so the same SKU could be advertised under two
 * URLs with no canonical consolidation. This module maps a live product (or a
 * `/product/<slug>` request) onto the catalog identity when the canonical
 * fields say it IS that SKU, and otherwise leaves the live id alone.
 *
 * Pure identity mapping: it reads titles/ids only, never prices. The catalog
 * is an identity table here, not a price source — every product page still
 * collects its offers live at request time.
 */
import { PRODUCTS } from "@/lib/feed";
import {
  canonicalFields,
  compatibleFields,
  type CanonicalFields,
} from "@/lib/collect/canonical-product";
import type { NormalizedProduct } from "@/types/product";

function catalogIdForFields(fields: CanonicalFields): string | null {
  // A key with neither model line nor storage is too generic to fold onto a
  // catalog row; leave the live identity alone.
  if (fields.modelLine === "" && fields.storage === "") return null;
  for (const candidate of PRODUCTS) {
    const candidateFields = canonicalFields(candidate.title);
    if (compatibleFields(fields, candidateFields)) return candidate.productId;
  }
  return null;
}

/** The catalog product id whose canonical identity is the same SKU as this
 *  live product, or null when the live SKU is not catalog-covered. */
export function catalogProductIdFor(
  product: Pick<NormalizedProduct, "title">,
): string | null {
  return catalogIdForFields(canonicalFields(product.title ?? ""));
}

/** Resolve the canonical id for a `/product/<slug>` request: a seeded id stays
 *  itself, a live slug that names a catalog SKU folds onto that catalog id,
 *  and anything else keeps its own id. */
export function canonicalProductIdForSlug(productId: string): string {
  const seeded = PRODUCTS.find((product) => product.productId === productId);
  if (seeded) return seeded.productId;
  const mapped = catalogIdForFields(
    canonicalFields(productId.replace(/[-_]+/g, " ").trim()),
  );
  return mapped ?? productId;
}

/** Catalog title for a canonical id, or null when the id is a live-only SKU. */
export function productTitleForId(productId: string): string | null {
  const product = PRODUCTS.find((candidate) => candidate.productId === productId);
  return product?.title ?? null;
}

/** A readable, product-specific title for a live-only slug. The slug is the
 *  merge identity, so this is presentation only — never an identity claim. */
export function humanizeProductSlug(productId: string): string {
  return productId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(gb|tb)$/i.test(word)) return word.toUpperCase();
      if (/^\d+(gb|tb)$/i.test(word)) {
        return `${word.slice(0, -2)}${word.slice(-2).toUpperCase()}`;
      }
      if (/^iphone/i.test(word)) return `iPhone ${word.slice(6)}`.trim();
      if (/^playstation/i.test(word)) return `PlayStation ${word.slice(11)}`.trim();
      if (/^[a-z]/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
