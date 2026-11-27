/**
 * REEA-1261 (Bet 7A-1) — the exact-model card the shelf must never lose.
 *
 * Measured live on `ffaf8fd`: `keychron v3 max` served ten Razer cards and no
 * Keychron at all, while the sitemap-advertised PDP `/product/keychron-v3-max`
 * rendered the exact product ("No Kuwait offer · Egypt price from KD 13.72").
 * Two independent causes:
 *
 *  1. the scope gate accepted a model-token-only answer ("V3") as identity, so
 *     any brand's V3 was stamped a primary result (fixed in lib/scope-gate.ts
 *     by requiring the query's curated brand);
 *  2. no lane answered with the exact model in this run (Jarir and Quadra
 *     return Razer rows for the phrase, Amazon.eg 503s), so a correct gate
 *     would leave the shelf empty for the product the shopper named.
 *
 * The PDP already answers (2) honestly: it seeds the page with the product's
 * last COMPLETED collection from the shared store (REEA-1211) — rows that
 * carry their own `collectedAt` and are marked `cache` ("Needs verification"),
 * never a bundled price. This module is the shelf's half of that same rule, so
 * the two surfaces cannot disagree about whether the exact model exists.
 *
 * The catalog supplies the IDENTITY only (REEA-1246 AC5); every painted price
 * comes from the stored live observation. When no stored observation exists
 * the shelf keeps its honest "no exact-model offer" state and related items
 * render below their labelled divider — nothing is invented.
 */
import { PRODUCTS } from "@/lib/feed";
import { classifyProductScope } from "@/lib/scope-gate";
import { carriesExactModel, exactModelQuery } from "@/lib/relevance";
import type { NormalizedProduct } from "@/types/product";

/**
 * The catalog identity that names the query's brand+model, or null. Pure and
 * deterministic: the lowest productId wins when several catalog rows answer
 * the same identity, so one query always resolves to one URL.
 */
export function exactModelIdentityProduct(
  query: string,
): NormalizedProduct | null {
  if (exactModelQuery(query) === null) return null;
  const candidates = PRODUCTS.filter((p) => carriesExactModel(query, p.title));
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  )[0];
}

/**
 * Stamp the scope verdict on a seeded card. The collector stamps every live
 * card (REEA-1200); a card the shelf folds in from the store must carry the
 * same fields, or the renderer's one scope chain would treat it as a
 * pre-gate card and fall back to a second confidence heuristic.
 */
export function stampSeededCard(
  query: string,
  product: NormalizedProduct,
): NormalizedProduct {
  return { ...product, ...classifyProductScope(query, product.title) };
}

/**
 * Fold the seeded exact-model card into a served snapshot.
 *
 * Idempotent and safe on every serve path (fresh, finalized, memo/KV replay):
 *  - a snapshot that already carries the identity (the live fan-out answered
 *    with it) is returned unchanged — the live row is the fresher answer;
 *  - a snapshot that already carries the seeded productId is returned
 *    unchanged, so re-serving a seeded snapshot cannot duplicate the card;
 *  - otherwise the exact card leads the product list. The shelf's own ranking
 *    (rankPrimaryByEffective) then keeps it first on a brand+model query.
 */
export function withExactModelCard(
  products: readonly NormalizedProduct[],
  seed: NormalizedProduct | null,
  query: string,
): NormalizedProduct[] {
  const list = [...products];
  if (!seed) return list;
  if (list.some((p) => p.productId === seed.productId)) return list;
  if (list.some((p) => carriesExactModel(query, p.title))) return list;
  return [seed, ...list];
}
