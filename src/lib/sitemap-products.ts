/**
 * REEA-1269 (Bet 1b, backend half) — the indexable product catalogue for
 * /sitemap.xml, folded from the LIVE observations this deployment collected.
 *
 * The measured defect: the sitemap listed 6 product URLs (the bundled catalog
 * seeds that happened to answer a PDP check) while the long tail of products
 * the live fan-out already collects never reached a crawler. A catalog seed is
 * an identity table, not an inventory: it holds ten rows and no prices.
 *
 * The inventory lives in the durable last-seen store
 * (lib/collect/last-seen.ts), which only real live fan-outs write
 * (`rememberRound`, one round per query, 14-day retention). This module reads
 * that store at request time and folds it into canonical PDP keys:
 *
 *  1. every stored round's hits are regrouped through the SAME merge primitive
 *     the results shelf and the PDP resolve against (`groupHitsAll`), so the
 *     productIds here are the shelf's own ids, not a lookalike slug;
 *  2. every id is folded through `canonicalProductIdForSlug` — one canonical
 *     URL per SKU (REEA-1189), so a live merge key like
 *     `apple-iphone17-pro-256gb` and its catalog identity
 *     `iphone-17-pro` cannot both be advertised;
 *  3. a candidate is listed only when the round that produced it is inside the
 *     observation window, so the URL carries recent live evidence.
 *
 * Data policy: no bundled catalog is presented as live. The catalog only
 * supplies the identity fold; every listed product traces to a stored round
 * with its own `collectedAt`. The PDP still re-collects its offers live at
 * request time (REEA-114/1192) — this module never freezes a price.
 *
 * Rate-limit citizenship: no retailer hop runs here. The whole catalogue is
 * one batched MGET against the shared store plus CPU-only regrouping, memoized
 * for a few minutes so crawlers do not re-pay it on every request.
 *
 * Server-only module; never import from client code.
 */
import { canonicalProductIdForSlug } from "@/lib/product-canonical";
import {
  COLLECTORS,
  groupHitsAll,
  type SearchHit,
} from "@/lib/collect/live-search";
import { productSlugFor } from "@/lib/collect/canonical-product";
import {
  diskCollectedQueries,
  readLatestSeenSnapshots,
  type SeenSnapshot,
} from "@/lib/collect/last-seen";
import { getSharedKv } from "@/lib/collect/kv";
import { recordPdpSources } from "@/lib/pdp-source";

/** Acceptance target (S-1): the sitemap must offer at least this many product
 *  URLs. Kept as a named constant so the probe and the tests read one number. */
export const SITEMAP_PRODUCT_TARGET = 200;

/** Hard ceiling on listed product URLs. A single sitemap file is fine at this
 *  size (the ticket explicitly defers index sharding); the cap keeps the
 *  payload small and the crawl budget spent on the freshest observations. */
export const SITEMAP_PRODUCT_CAP = 500;

/** How recent a stored round must be for its products to be advertised. The
 *  store keeps 14 days; three days is long enough that a quiet query keeps its
 *  inventory listed, short enough that the advertised PDP is still likely to
 *  answer live on the next crawl. */
export const SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** In-process memo for the folded catalogue: crawlers hit the route far more
 *  often than the store changes meaningfully, and the fold is the expensive
 *  part. Short enough that a newly collected round shows up promptly. */
export const SITEMAP_PRODUCT_MEMO_MS = 10 * 60 * 1000;

export interface SitemapProduct {
  /** The one canonical PDP key for this SKU (already folded). */
  canonicalId: string;
  /**
   * The live merge key the group was minted under (before the canonical fold).
   * Equal to `canonicalId` for a live-only SKU; different when the SKU folded
   * onto a catalog identity.
   */
  productId: string;
  /** Display title of the merged card (identity only; never a price claim). */
  title: string;
  /** Epoch ms of the newest live observation that named this SKU. */
  observedAtMs: number;
  /** Offers that observation carried (evidence, not a served price). */
  offerCount: number;
  /** The collected query that minted this group — the PDP's source hint
   *  (lib/pdp-source.ts) so a bare-slug visit reproduces the shelf's run. */
  sourceQuery: string;
}

interface MemoEntry {
  at: number;
  key: string;
  products: SitemapProduct[];
}

let memo: MemoEntry | null = null;

/** Test hook: drop the in-process memo between cases. */
export function resetSitemapProductsForTests(): void {
  memo = null;
}

/**
 * Fold the stored live rounds for these queries into canonical PDP keys.
 *
 * Returns at most `SITEMAP_PRODUCT_CAP` entries, freshest first, one per
 * canonical id. Never throws: a store hiccup degrades to a shorter list (the
 * sitemap then keeps its catalog-verified seeds), never to a failed route.
 */
export async function sitemapProducts(
  queries: ReadonlyArray<string>,
  nowMs: number = Date.now(),
): Promise<SitemapProduct[]> {
  const memoKey = queries.join("\u0000");
  if (memo && memo.key === memoKey && nowMs - memo.at < SITEMAP_PRODUCT_MEMO_MS) {
    return memo.products;
  }
  const products = await foldStoredRounds(queries, nowMs);
  memo = { at: nowMs, key: memoKey, products };
  return products;
}

/**
 * How many collected queries the fold may read. Each query costs one stored
 * round per lane, so this bounds the batch read (rate-limit citizenship: no
 * retailer hop, but the shared store is still a shared resource).
 */
export const SITEMAP_PRODUCT_QUERY_LIMIT = 32;

/**
 * REEA-1269 — the queries this deployment has actually collected, ranked by
 * lane coverage (how many retailers answered for that query), read from the
 * `seen:` keyspace the live rounds already write. No new store, no new key.
 *
 * This is what keeps the inventory on demand rather than on a curated list:
 * the sitemap's own query seeds are the pages it advertises, but the products
 * a crawler needs are the ones behind every query the box really served.
 * Best-effort: no binding / no `keys` support → the caller's own queries only.
 */
export async function collectedQueries(limit = SITEMAP_PRODUCT_QUERY_LIMIT): Promise<string[]> {
  const coverage = new Map<string, number>();
  const countQuery = (query: string): void => {
    const trimmed = query.trim();
    if (!trimmed) return;
    coverage.set(trimmed, (coverage.get(trimmed) ?? 0) + 1);
  };
  const countKey = (name: string): void => {
    // `seen:<merchant>:<query>` — the merchant never contains a colon, so the
    // first one after the prefix is the separator.
    const rest = name.slice("seen:".length);
    const sep = rest.indexOf(":");
    if (sep < 0) return;
    countQuery(rest.slice(sep + 1));
  };
  try {
    const kv = getSharedKv();
    if (kv?.keys) {
      const names = await kv.keys("seen:*");
      if (names) for (const name of names) countKey(name);
    }
  } catch {
    /* a keyspace hiccup still leaves the disk layer below */
  }
  // Degraded layer (no binding configured): same rounds, local store. It
  // answers bare query strings, not `seen:` keys.
  try {
    for (const query of diskCollectedQueries()) countQuery(query);
  } catch {
    /* best-effort */
  }
  return [...coverage.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([query]) => query);
}

/** The fold itself (memo-free, exported for the focused pin). */
export async function foldStoredRounds(
  queries: ReadonlyArray<string>,
  nowMs: number = Date.now(),
): Promise<SitemapProduct[]> {
  const merchants = COLLECTORS.map((collector) => collector.merchant);
  // The advertised query set plus the collected demand set, deduped
  // case-insensitively and bounded: the store keys are case-folded, so two
  // spellings of one query are one read.
  const foldQueries: string[] = [];
  const seenQueries = new Set<string>();
  // Collected queries first: those are the ones known to have stored rounds,
  // so the bounded read spends its budget where the inventory is.
  for (const query of [...(await collectedQueries()), ...queries]) {
    const trimmed = query.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);
    foldQueries.push(trimmed);
    if (foldQueries.length >= SITEMAP_PRODUCT_QUERY_LIMIT) break;
  }
  let snapshots: SeenSnapshot[] = [];
  try {
    snapshots = await readLatestSeenSnapshots(foldQueries, merchants, {
      now: nowMs,
      maxAgeMs: SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS,
    });
  } catch {
    snapshots = [];
  }

  const byCanonical = new Map<string, SitemapProduct>();
  const consider = (candidate: SitemapProduct): void => {
    if (!candidate.canonicalId) return;
    const prev = byCanonical.get(candidate.canonicalId);
    if (!prev || candidate.observedAtMs > prev.observedAtMs) {
      byCanonical.set(candidate.canonicalId, candidate);
    }
  };

  // Tier 1 — regroup each query's stored live round and keep the merged cards.
  // This is the exact identity the results shelf mints, so the advertised URL
  // is the shelf's canonical PDP for that SKU.
  const hitsByQuery = new Map<string, SearchHit[]>();
  for (const snapshot of snapshots) {
    const bucket = hitsByQuery.get(snapshot.query);
    if (bucket) bucket.push(...snapshot.hits);
    else hitsByQuery.set(snapshot.query, [...snapshot.hits]);
  }
  const roundStampByQuery = new Map<string, number>();
  for (const snapshot of snapshots) {
    const t = Date.parse(snapshot.collectedAt);
    if (!Number.isFinite(t)) continue;
    const prev = roundStampByQuery.get(snapshot.query) ?? 0;
    if (t > prev) roundStampByQuery.set(snapshot.query, t);
  }
  for (const [query, hits] of hitsByQuery) {
    if (hits.length === 0) continue;
    const roundStamp = roundStampByQuery.get(query) ?? 0;
    if (roundStamp === 0 || nowMs - roundStamp > SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS) continue;
    let merged;
    try {
      merged = groupHitsAll(query, hits);
    } catch {
      continue;
    }
    for (const product of merged) {
      const offers = (product.offers ?? []) as ReadonlyArray<{ collectedAt?: string }>;
      if (offers.length === 0) continue;
      let observedAtMs = 0;
      for (const offer of offers) {
        const t = Date.parse(offer.collectedAt ?? "");
        if (Number.isFinite(t) && t > observedAtMs) observedAtMs = t;
      }
      if (observedAtMs === 0) observedAtMs = roundStamp;
      if (nowMs - observedAtMs > SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS) continue;
      consider({
        canonicalId: canonicalProductIdForSlug(product.productId),
        productId: product.productId,
        title: product.title,
        observedAtMs,
        offerCount: offers.length,
        sourceQuery: query,
      });
    }
  }

  // Tier 2 — the day history keeps ≤14 slots of per-offer merge identities.
  // When the latest rounds alone are thin (a quiet query), those identities
  // still name real SKUs the retailers served inside the window; minting their
  // canonical slug keeps the long tail indexable. Identities carry no title, so
  // the slug is the identity and the day slot is the observation stamp.
  if (byCanonical.size < SITEMAP_PRODUCT_TARGET) {
    for (const snapshot of snapshots) {
      for (const slot of snapshot.days) {
        const t = Date.parse(slot.observedAt);
        if (!Number.isFinite(t) || nowMs - t > SITEMAP_PRODUCT_OBSERVATION_WINDOW_MS) continue;
        for (const offer of slot.offers) {
          if (!offer.identity) continue;
          const slug = productSlugFor(offer.identity.fields);
          if (!slug) continue;
          consider({
            canonicalId: canonicalProductIdForSlug(slug),
            productId: slug,
            title: slug.replace(/-/g, " "),
            observedAtMs: t,
            offerCount: 1,
            sourceQuery: snapshot.query,
          });
        }
      }
    }
  }

  const listed = [...byCanonical.values()]
    .sort((a, b) => b.observedAtMs - a.observedAtMs || a.canonicalId.localeCompare(b.canonicalId))
    .slice(0, SITEMAP_PRODUCT_CAP);

  // S-2 — the listed URL must paint the shelf's offer set, not an empty table.
  // A live-only key resolves its slug phrase on a bare visit, and that phrase
  // is not always what the retailers answer for (measured: zero-row PDPs that
  // painted with the source query carried). Persist the query that minted each
  // live-only key so lib/product-identity.ts can dispatch the shelf's own run.
  // Catalog identities resolve through their catalog title, so they need no
  // hint. Best-effort and missing-only, so the steady state writes nothing.
  await recordPdpSources(
    listed
      .filter((product) => product.canonicalId === product.productId)
      .map((product) => ({ productId: product.productId, query: product.sourceQuery })),
  );

  return listed;
}
