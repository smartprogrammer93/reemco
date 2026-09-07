import type { NormalizedProduct } from "@/types/product";
import { CATALOG } from "@/lib/catalog";
import { searchProducts } from "@/lib/search";
import type { CountryCode } from "@/lib/country";

/**
 * Data layer facade.
 *
 * TODO(data-engineer): swap CATALOG for the Scraping/Data Engineer's
 * normalized feed (JSON file, API, or KV) while keeping the return shapes
 * identical (src/types/product.ts).
 */
export const PRODUCTS: NormalizedProduct[] = CATALOG;

export const filterProducts = searchProducts;

/**
 * REEA-114 — resolve a product identity for follow-through pages
 * (/product/[id], collection routes). Catalog ids win first; ids produced by
 * the LIVE query-time collector (slugified scraped titles) are decoded back
 * into a search query and resolved against the same live fan-out, so
 * result → detail → retailer links stay on one consistent live path.
 * REEA-170 — the optional country selection scopes the live resolution to the
 * adapters tagged for that country, keeping detail-page figures on the same
 * filtered offer set as the results list that linked here.
 */
export async function resolveProductIdentity(
  productId: string,
  country?: CountryCode | null,
): Promise<NormalizedProduct | null> {
  const seeded = PRODUCTS.find((p) => p.productId === productId);
  if (seeded) return seeded;
  const query = productId.replace(/-/g, " ").trim();
  if (!query) return null;
  const { collectLiveResults } = await import("@/lib/collect/live-search");
  const { products } = await collectLiveResults(query, { country: country ?? null });
  return (
    products.find((p) => p.productId === productId) ?? products[0] ?? null
  );
}
