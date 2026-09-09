import { PRODUCTS } from "@/lib/feed";
import { canonicalFields, compatibleFields } from "@/lib/collect/canonical-product";
import type { CountryCode } from "@/lib/country";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-114 — resolve a product identity for follow-through pages
 * (/product/[id], collection routes). Catalog ids win first; ids produced by
 * the LIVE query-time collector (slugified scraped titles) are decoded back
 * into a search query and resolved against the same live fan-out, so
 * result → detail → retailer links stay on one consistent live path.
 * REEA-170 — the optional country selection scopes the live resolution to the
 * adapters tagged for that country, keeping detail-page figures on the same
 * filtered offer set as the results list that linked here.
 *
 * REEA-437 — moved out of feed.ts so the browser-safe facade (PRODUCTS,
 * filterProducts) no longer carries the live-collector hop into client
 * bundles: the results shell imports PRODUCTS only, and this server-only
 * resolution lives one import away. Behavior unchanged.
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
  const exact = products.find((p) => p.productId === productId);
  if (exact) return exact;
  // REEA-167 §2 alias behaviour, rendered in place: an alias slug decodes to
  // its canonical fields and lands on the SAME live group as the canonical
  // slug, so both spellings of one device show the identical merged view.
  // When the group cannot be matched from the requested slug's tokens, fall
  // back to the top-ranked live product as before.
  const want = canonicalFields(query);
  return (
    products.find((p) => compatibleFields(want, canonicalFields(p.title))) ??
    products[0] ??
    null
  );
}
