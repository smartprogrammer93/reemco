/**
 * REEA-1277 — resolve a listed live-only product key from the stored
 * observation that minted it.
 *
 * The measured defect on the served head (`d9e411c9`): `/sitemap.xml` lists
 * ~287 product URLs, the canonical tag on each is self-aligned, but a cold
 * PDP visit can paint a DIFFERENT product's offer set. The sitemap mints its
 * inventory from the durable last-seen store (lib/sitemap-products.ts); the
 * PDP re-runs the source query live and looks for the exact productId in the
 * run's merged cards. When the retailer shelf changed between the stored
 * round and today's live answer, that id is absent from the run, and
 * `resolveProductIdentity` fell through to a canonical neighbour (or
 * `fallbackPool[0]`) — so `/product/sandisk-extreme-…` served an OPPO phone,
 * `/product/lenovo-gillette-256gb` served an Asus keyboard, and two listed
 * URLs rendered the same offer set. An alias key painting someone else's
 * offers is exactly the thin duplicate key S-2 forbids.
 *
 * This module re-derives the exact identity from the SAME stored evidence the
 * sitemap fold used — no new store, no retailer hop:
 *
 *  1. regroup the stored round's hits through `groupHitsAll` (the merge
 *     primitive the shelf and the sitemap fold share) and return the product
 *     whose productId is the requested key. This is deterministic on the same
 *     stored hits, so a listed tier-1 key always resolves to itself.
 *  2. for a tier-2 alias key (minted from a stored listing identity in
 *     lib/sitemap-products.ts), find the day-slot identity whose
 *     `productSlugFor(fields)` is that key and rebuild the product from the
 *     day-slot rows (each row carries its own merchant and observation
 *     stamp, so the painted figures stay traceable to a real live fetch).
 *  3. fall back to the last COMPLETED observation stored for this exact key.
 *
 * Every branch returns a product whose `productId` is the requested key, and
 * every offer carries its own `collectedAt`; the page's own live re-check
 * still runs on top, so nothing here freezes a price or invents a listing.
 *
 * Server-only module; never import from client code.
 */
import {
  productSlugFor,
} from "@/lib/collect/canonical-product";
import { lastVerifiedObservation } from "@/lib/collect/last-observation";
import { readLatestSeenSnapshots, type SeenSnapshot } from "@/lib/collect/last-seen";
import { SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS } from "@/lib/sitemap-products";
import { humanizeProductSlug } from "@/lib/product-canonical";
import type { SearchHit } from "@/lib/collect/live-search";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/**
 * A stored product with no title/url of its own is titled from its identity
 * slug — presentation only, never an identity claim.
 */
function identityTitle(productId: string): string {
  return humanizeProductSlug(productId) || productId;
}

/**
 * Rebuild a tier-2 key from the day-slot listing identities the sitemap fold
 * minted it from. `url` is not stored in the day slot, so a rebuilt row keeps
 * its merchant, price and observation stamp and renders without a clickable
 * listing link (the page's live re-check can still re-discover the listing by
 * the product title).
 */
function productFromDaySlots(
  productId: string,
  snapshots: readonly SeenSnapshot[],
  nowMs: number,
): NormalizedProduct | null {
  const offers: PriceOffer[] = [];
  let brand = "";
  for (const snapshot of snapshots) {
    for (const slot of snapshot.days ?? []) {
      const observedAtMs = Date.parse(slot.observedAt);
      if (!Number.isFinite(observedAtMs)) continue;
      if (nowMs - observedAtMs > SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS) continue;
      for (const row of slot.offers) {
        const identity = row.identity;
        if (!identity?.fields) continue;
        if (productSlugFor(identity.fields) !== productId) continue;
        if (!brand && identity.fields.brand) brand = identity.fields.brand;
        offers.push({
          merchant: snapshot.merchant,
          price: row.price,
          currency: row.currency,
          market: row.country,
          url: "",
          inStock: true,
          collectedAt: slot.observedAt,
          collectedAtEpochMs: observedAtMs,
          fromSnapshot: true,
        });
      }
    }
  }
  if (offers.length === 0) return null;
  // The same merchant+price+currency is one observation; two day slots for
  // the same round must not paint a row twice.
  const seen = new Set<string>();
  const deduped = offers.filter((offer) => {
    const key = `${offer.merchant}\u0000${offer.price}\u0000${offer.currency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    productId,
    title: identityTitle(productId),
    brand,
    offers: deduped,
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

/**
 * The exact product this listed key names, from the stored live rounds behind
 * it. Returns null when the store holds no evidence for the key (the caller
 * then keeps its legacy alias/neighbour resolution).
 *
 * Never throws: every store read degrades to the next branch.
 */
export async function resolveStoredProductIdentity(
  productId: string,
  queries: readonly string[],
  nowMs: number = Date.now(),
): Promise<NormalizedProduct | null> {
  const wanted = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
  if (wanted.length === 0) return null;

  // The focused tests replace the live-search module with a partial mock;
  // a missing grouping primitive must not fail the page's resolution.
  let groupHitsAll: typeof import("@/lib/collect/live-search").groupHitsAll | undefined;
  let collectors: typeof import("@/lib/collect/live-search").COLLECTORS | undefined;
  try {
    const live = await import("@/lib/collect/live-search");
    groupHitsAll = live.groupHitsAll;
    collectors = live.COLLECTORS;
  } catch {
    return null;
  }
  if (typeof groupHitsAll !== "function" || !Array.isArray(collectors)) return null;

  let snapshots: SeenSnapshot[] = [];
  try {
    snapshots = await readLatestSeenSnapshots(wanted, collectors.map((c) => c.merchant), {
      now: nowMs,
      maxAgeMs: SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS,
    });
  } catch {
    snapshots = [];
  }
  if (snapshots.length === 0) return null;

  // Branch 1 — the stored round's own merged card set. The sitemap fold built
  // its tier-1 keys from exactly this primitive over these hits, so the key
  // is reproducible here by construction.
  const hitsByQuery = new Map<string, SearchHit[]>();
  for (const snapshot of snapshots) {
    const bucket = hitsByQuery.get(snapshot.query);
    if (bucket) bucket.push(...snapshot.hits);
    else hitsByQuery.set(snapshot.query, [...snapshot.hits]);
  }
  for (const [query, hits] of hitsByQuery) {
    if (hits.length === 0) continue;
    let merged: NormalizedProduct[];
    try {
      merged = groupHitsAll(query, hits);
    } catch {
      continue;
    }
    const exact = merged.find((product) => product.productId === productId);
    if (exact) return exact;
  }

  // Branch 2 — the tier-2 alias minted from a stored listing identity.
  const fromDaySlots = productFromDaySlots(productId, snapshots, nowMs);
  if (fromDaySlots) return fromDaySlots;

  // Branch 3 — the last completed observation stored under this exact key.
  const stored = await lastVerifiedObservation(productId, nowMs);
  if (!stored) return null;
  return {
    productId,
    title: identityTitle(productId),
    brand: "",
    offers: stored as unknown as PriceOffer[],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}
