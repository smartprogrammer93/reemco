/**
 * REEA-1268 — the pure projection behind a `/c/<slug>` live category shelf.
 *
 * One category surface fans out over the static seed terms in
 * `lib/categories.ts` (a live per-query retailer fan-out per term, the same
 * collection path the results page runs). This module turns the snapshots
 * that fan-out produced into the card set the shelf may paint:
 *
 *  - each term's PRIMARY shelf is derived through the renderer's own chain
 *    (`shelfSectionsFromProducts`), so the scope gate, the accessory band and
 *    the market/stock selections apply exactly as they do on /results;
 *  - the static category membership guard drops any card whose title is not
 *    this category (a supplementary term can never pad the shelf);
 *  - cards are de-duplicated by productId (one card per product, the richer
 *    offer set wins) and the caller caps the painted shelf at the category
 *    budget;
 *  - notes are merged per merchant so the coverage line counts stores, not
 *    term×store repetitions.
 *
 * Pure: no I/O, no clock read beyond the snapshots' own stamps. Client-safe
 * (the streaming shelf imports the stage type), and never invents a product.
 */
import type { CountryCode } from "@/lib/country";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import { shelfSectionsFromProducts } from "@/lib/results-shelf";
import { isCategoryMember, type CategorySurface } from "@/lib/categories";
import type { NormalizedProduct } from "@/types/product";

/** One seed term's snapshot at a given flush (null when the run could not answer). */
export interface CategoryTermSnapshot {
  term: string;
  snap: LiveSearchResult | null;
}

/**
 * What one streamed category flush paints from. `cards` is the full
 * category-matched payload available at this flush (uncapped, de-duplicated);
 * the renderer caps the painted shelf and reports `cards.length` as the
 * available count in the honest "showing X of Y" line.
 */
export interface CategoryStage {
  cards: NormalizedProduct[];
  notes: LiveSearchResult["notes"];
  collectedAt?: string;
  collectedAtEpochMs?: number;
  /** True only when every term answered AND no run finalized at its budget. */
  settled: boolean;
  /** True when at least one term could not answer or finalized at the budget. */
  partial: boolean;
  answeredTerms: number;
  totalTerms: number;
}

function newestStamp(parts: readonly CategoryTermSnapshot[]): {
  collectedAt?: string;
  collectedAtEpochMs?: number;
} {
  let best: number | null = null;
  let iso: string | undefined;
  for (const { snap } of parts) {
    if (!snap) continue;
    const epoch = snap.collectedAtEpochMs ?? Date.parse(snap.collectedAt ?? "");
    if (!Number.isFinite(epoch)) continue;
    if (best == null || epoch > best) {
      best = epoch;
      iso = snap.collectedAt ?? new Date(epoch).toISOString();
    }
  }
  return best == null ? {} : { collectedAt: iso, collectedAtEpochMs: best };
}

/**
 * Merge per-merchant notes across the category's terms. A merchant that
 * answered ANY term answered the category: a sibling term's timeout must not
 * name it as failed in the coverage line. Hits are summed so a store that
 * carries several terms' products still counts once.
 */
export function mergeCategoryNotes(
  parts: readonly CategoryTermSnapshot[],
): LiveSearchResult["notes"] {
  const rows = new Map<
    string,
    { merchant: string; hits: number; coupons?: number; error?: string }
  >();
  for (const { snap } of parts) {
    if (!snap) continue;
    for (const n of snap.notes ?? []) {
      const prev = rows.get(n.merchant);
      if (!prev) {
        rows.set(n.merchant, {
          merchant: n.merchant,
          hits: n.hits ?? 0,
          ...(n.coupons != null ? { coupons: n.coupons } : {}),
          ...(n.error ? { error: n.error } : {}),
        });
        continue;
      }
      prev.hits += n.hits ?? 0;
      if (n.coupons != null) prev.coupons = (prev.coupons ?? 0) + n.coupons;
      if (n.error && !prev.error) prev.error = n.error;
    }
  }
  for (const row of rows.values()) {
    if (row.hits > 0) delete row.error;
  }
  return [...rows.values()];
}

/**
 * Build one flush of the category shelf from the per-term snapshots that
 * landed at that flush. `expectedTerms` is the number of seed terms the page
 * started, so a run that never answered is visible as `partial` rather than
 * silently counted as an honest zero.
 */
export function mergeCategoryStage(
  parts: readonly CategoryTermSnapshot[],
  def: CategorySurface,
  country: CountryCode | null,
  showOutOfStock: boolean,
  expectedTerms: number,
): CategoryStage {
  const cards: NormalizedProduct[] = [];
  const seen = new Map<string, NormalizedProduct>();
  for (const { term, snap } of parts) {
    if (!snap) continue;
    let primary: NormalizedProduct[];
    try {
      primary = shelfSectionsFromProducts(
        snap.products,
        term,
        country,
        showOutOfStock,
      ).primary;
    } catch {
      // A malformed snapshot must not blank the shelf: fall back to its own
      // products and let the membership guard decide.
      primary = [...snap.products];
    }
    for (const p of primary) {
      if (!isCategoryMember(p.title, def)) continue;
      const existing = seen.get(p.productId);
      if (!existing) {
        seen.set(p.productId, p);
        cards.push(p);
        continue;
      }
      // One card per product. The richer live offer set wins, in the slot the
      // product already holds (never a second card for the same PDP).
      if ((p.offers?.length ?? 0) > (existing.offers?.length ?? 0)) {
        const idx = cards.indexOf(existing);
        if (idx >= 0) cards[idx] = p;
        seen.set(p.productId, p);
      }
    }
  }
  const answeredTerms = parts.filter((p) => p.snap !== null).length;
  const settled =
    parts.length >= expectedTerms &&
    answeredTerms === expectedTerms &&
    parts.every((p) => p.snap !== null && p.snap.settled !== false);
  return {
    cards,
    notes: mergeCategoryNotes(parts),
    ...newestStamp(parts),
    settled,
    partial: !settled,
    answeredTerms,
    totalTerms: expectedTerms,
  };
}
