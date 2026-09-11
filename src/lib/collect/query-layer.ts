/**
 * REEA-602 — the shared-layer warm for the query memo.
 *
 * The per-query response memo (REEA-277 / REEA-291 AC5) is a bounded
 * per-instance Map, so the FIRST hit on a freshly recycled instance re-pays
 * the whole fan-out even when a sibling instance converged the SAME query a
 * few seconds earlier. This layer rides the REEA-92 shared KV binding that
 * already carries cross-instance state (collect jobs, clearance jars
 * REEA-272/369/276, last-seen rows REEA-510/540): the FINAL write-through
 * snapshot of each memo identity is mirrored there with the memo ceiling as
 * TTL, and a cold instance replays it as its honestly-aged first flush. The
 * live run still executes behind the response — the replay shortens the
 * first paint, it never replaces the live-at-query-time fetch, and entries
 * are only ever written by real fan-out rounds of this deployment itself.
 *
 * Best-effort by contract (the REEA-92 rule): no KV binding or a hiccup
 * reads as a plain miss, never as a failed request. Server-only module.
 */
import { QUERY_CACHE_MAX_AGE_MS } from "@/lib/query-cache";
import { getSharedKv } from "@/lib/collect/kv";

/** Namespace for mirrored query snapshots: one entry per memo identity. */
export const SHARED_QUERY_PREFIX = "pc:q:";

/** Shared-layer key of one memo entry; the memo key is already normalized,
 *  so only the URL-safe encoding is added around it. */
export function sharedQuerySnapshotKey(cacheKey: string): string {
  return `${SHARED_QUERY_PREFIX}${encodeURIComponent(cacheKey)}`;
}

/**
 * Replay this query's last FINAL snapshot from the shared layer, or null on
 * any miss. Never rejects: a KV hiccup is a miss, not a failed request. The
 * shape check stays deliberately shallow — mirrored values are live-run
 * snapshots with a products array — so anything else (a foreign key, a torn
 * write) reads as a miss and the caller simply runs the live path.
 */
export async function replaySharedQuerySnapshot<T>(
  cacheKey: string,
): Promise<T | null> {
  const kv = getSharedKv();
  if (!kv) return null;
  const raw = await kv.get(sharedQuerySnapshotKey(cacheKey));
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as T | null;
    return snap && typeof snap === "object" && Array.isArray((snap as { products?: unknown }).products)
      ? snap
      : null;
  } catch {
    return null;
  }
}

/**
 * Mirror one FINAL write-through snapshot with the memo ceiling as TTL — a
 * replayed answer never ages faster than the local memo would have served
 * it. Best effort: the ack is returned for tests; callers fire it behind the
 * response and never block on it.
 */
export async function mirrorSharedQuerySnapshot<T>(
  cacheKey: string,
  snap: T,
): Promise<boolean> {
  const kv = getSharedKv();
  if (!kv) return false;
  try {
    return await kv.set(
      sharedQuerySnapshotKey(cacheKey),
      JSON.stringify(snap),
      Math.ceil(QUERY_CACHE_MAX_AGE_MS / 1000),
    );
  } catch {
    return false;
  }
}
