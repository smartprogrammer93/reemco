import type { NormalizedProduct } from "@/types/product";
import { CATALOG } from "@/lib/catalog";
import { searchProducts } from "@/lib/search";

/**
 * Data layer facade.
 *
 * TODO(data-engineer): swap CATALOG for the Scraping/Data Engineer's
 * normalized feed (JSON file, API, or KV) while keeping the return shapes
 * identical (src/types/product.ts).
 */
export const PRODUCTS: NormalizedProduct[] = CATALOG;

export const filterProducts = searchProducts;
