/**
 * REEA-1269 (Bet 1b) — the source query behind a live-only product key.
 *
 * A `/product/<slug>` URL is minted from the merge identity of a group a live
 * fan-out produced for SOME query. The results card links carry that query
 * (`?q=`), so a click-through reproduces the shelf's own run (REEA-1140). A
 * sitemap URL, a shared link or a bare visit does not: the PDP falls back to
 * decoding the slug into a search phrase, and that phrase is not always what
 * the retailer answers for. Measured on the deployed head: three of a
 * twenty-five-URL sample rendered `<div class="rc-offers-table"
 * aria-busy="true">` with zero offer rows, while the same URL with
 * `?q=samsung` painted the shelf's offers — the slug phrase
 * ("samsung freestanding dishwasher energy efficiency class c flex load14 …")
 * is not a query any retailer index matches.
 *
 * This module stores the one fact that fixes it: the query that minted the
 * product. It is identity/provenance only — never a price — so the PDP can
 * dispatch the shelf's own run for a bare slug and paint the offer set the
 * sitemap promised (S-2), instead of an empty table.
 *
 * Written by the sitemap's inventory fold (lib/sitemap-products.ts), only for
 * live-only ids (a catalog id resolves through its own catalog identity) and
 * only when the entry is missing, so the steady-state cost is one batch read
 * per fold. Best-effort by the shared-store contract: a hiccup degrades to the
 * decoded-slug path the PDP had before.
 *
 * Server-only module; never import from client code.
 */
import { getSharedKv } from "@/lib/collect/kv";

/** Namespace for one product key's source query. */
export const PDP_SOURCE_PREFIX = "pdp:src:v1:";

/** Outlive the observation window so a listed URL keeps resolving between
 *  folds; a missing entry is simply rewritten by the next fold. */
export const PDP_SOURCE_TTL_S = 14 * 24 * 60 * 60;

/** Upper bound on writes one fold may perform (first render after a deploy). */
export const PDP_SOURCE_MAX_WRITES = 600;

export function pdpSourceKey(productId: string): string {
  return `${PDP_SOURCE_PREFIX}${encodeURIComponent(productId)}`;
}

/** The query that minted this product key, or null when unknown. Never throws. */
export async function readPdpSource(productId: string): Promise<string | null> {
  try {
    const kv = getSharedKv();
    if (!kv) return null;
    const raw = await kv.get(pdpSourceKey(productId));
    const value = (raw ?? "").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Persist the source query for each product key, skipping entries that already
 * have one. Returns the number of keys written (0 when the store is absent or
 * the batch read failed closed). Never throws.
 */
export async function recordPdpSources(
  entries: ReadonlyArray<{ productId: string; query: string }>,
): Promise<number> {
  const kv = getSharedKv();
  if (!kv) return 0;
  const unique = new Map<string, string>();
  for (const entry of entries) {
    const productId = entry.productId.trim();
    const query = entry.query.trim();
    if (!productId || !query) continue;
    if (!unique.has(productId)) unique.set(productId, query);
  }
  const pairs = [...unique.entries()].slice(0, PDP_SOURCE_MAX_WRITES);
  if (pairs.length === 0) return 0;
  let existing: (string | null)[] | null = null;
  try {
    existing = kv.mget
      ? await kv.mget(pairs.map(([productId]) => pdpSourceKey(productId)))
      : await Promise.all(pairs.map(([productId]) => kv.get(pdpSourceKey(productId)).catch(() => null)));
  } catch {
    existing = null;
  }
  // A failed batch read must not be mistaken for "every key is missing" — it
  // would rewrite all of them every fold. Treat it as "assume present".
  if (existing === null) return 0;
  let written = 0;
  // Bounded concurrency: the self-hosted Redis binding opens one short-lived
  // connection per command, so a first fold after a deploy must not fire
  // hundreds of sockets at once.
  const WRITE_CONCURRENCY = 24;
  for (let i = 0; i < pairs.length; i += WRITE_CONCURRENCY) {
    const chunk = pairs.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(
      chunk.map(async ([productId, query], j) => {
        const current = (existing?.[i + j] ?? "").trim();
        if (current === query) return;
        try {
          if (await kv.set(pdpSourceKey(productId), query, PDP_SOURCE_TTL_S)) written++;
        } catch {
          /* best-effort */
        }
      }),
    );
  }
  return written;
}
