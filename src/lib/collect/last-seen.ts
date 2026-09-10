/**
 * REEA-510 — labeled last-seen snapshots for silent retailer columns.
 *
 * Four retailers (Sultan Center, Quadra Stores, PC Kuwait, Lulu Hypermarket)
 * go silent-zero for stretches: their live hop times out or answers an empty
 * shelf, and the shopper reads the blank column as a broken site. After the
 * LIVE pass of a run has settled, every merchant that ANSWERED leaves a
 * bounded snapshot of its offers per retailer+query behind in the shared KV
 * store (the REEA-92 binding; disk-cache degradation like store.ts when no KV
 * is configured). When a later run's live pass for the SAME retailer+query
 * stays silent, its rows come back from that snapshot with a visible
 * collection-time label — a genuine empty filled with honestly-aged offers,
 * never a replacement for the live-at-query-time path:
 *
 *  - live answers always win: snapshot rows are only consulted for merchants
 *    whose LIVE pass kept zero offers (fillSilentFromLastSeen),
 *  - a fresh live answer overwrites the snapshot on that same run's converge
 *    tail (rememberRound), so the fallback replaces itself automatically,
 *  - snapshots older than 24 h are dropped on read even if the store kept
 *    them, so a served label is always "collected within the last day",
 *  - snapshots are bounded (MAX_SNAPSHOT_OFFERS rows per retailer+query) and
 *    introduce no new persistent identifiers — the key is the same merchant
 *    name + normalized query string the whole app already uses as identity
 *    (data minimization).
 *
 * Everything is best-effort: KV hiccups and disk errors degrade to plain
 * live-path behavior (the REEA-92 contract), never to a failed request.
 *
 * Server-only module (node:fs through the same paths store.ts uses); never
 * import it from client code.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CountryCode } from "@/lib/country";
import { COLLECT_CACHE_DIR } from "@/lib/collect/store";
import { getSharedKv } from "@/lib/collect/kv";
import type { SearchHit } from "@/lib/collect/live-search";

/** A snapshot stays servable for one day; past it the read drops the entry. */
export const LAST_SEEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Rows kept per retailer+query — bounded, the adapter's own best-first order. */
export const MAX_SNAPSHOT_OFFERS = 10;
/** Bounded disk layer: oldest-first eviction, same ceiling as the memo. */
const MAX_SNAPSHOT_ENTRIES = 250;
const KV_TTL_S = Math.ceil(LAST_SEEN_MAX_AGE_MS / 1000);

interface LastSeenEntry {
  /** ISO stamp of the LIVE round that produced this snapshot (age basis). */
  collectedAt: string;
  hits: SearchHit[];
}

type LastSeenTable = Record<string, LastSeenEntry>;

/**
 * Snapshot identity: merchant + NORMALIZED QUERY STRING — the same folded
 * identity the response memo uses (REEA-291 AC5). Case and surrounding
 * whitespace fold together; nothing viewer-side joins the key.
 */
export function lastSeenKey(merchant: string, query: string): string {
  return `seen:${merchant}:${query.trim().toLowerCase()}`;
}

/* ---------- disk degradation (no KV binding — mirrors store.ts) ---------- */

function diskFile(dir = COLLECT_CACHE_DIR): string {
  return join(dir, "last-seen.json");
}

function readTable(dir?: string): LastSeenTable {
  try {
    return JSON.parse(readFileSync(diskFile(dir), "utf8")) as LastSeenTable;
  } catch {
    return {};
  }
}

function writeTable(table: LastSeenTable, dir?: string): void {
  const file = diskFile(dir);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(table));
  renameSync(tmp, file);
}

/** Drop >24 h entries, then evict oldest-first past the bounded ceiling. */
function pruneTable(table: LastSeenTable, now: number): LastSeenTable {
  const fresh: LastSeenTable = {};
  for (const [key, entry] of Object.entries(table)) {
    const t = Date.parse(entry?.collectedAt ?? "");
    if (!Number.isNaN(t) && now - t <= LAST_SEEN_MAX_AGE_MS) fresh[key] = entry;
  }
  const keys = Object.keys(fresh);
  if (keys.length <= MAX_SNAPSHOT_ENTRIES) return fresh;
  keys
    .sort((a, b) => Date.parse(fresh[a].collectedAt) - Date.parse(fresh[b].collectedAt))
    .slice(0, keys.length - MAX_SNAPSHOT_ENTRIES)
    .forEach((k) => delete fresh[k]);
  return fresh;
}

function asEntry(value: unknown): LastSeenEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as LastSeenEntry;
  if (typeof entry.collectedAt !== "string" || !Array.isArray(entry.hits)) return null;
  return entry;
}

/* ---------- public surface ---------- */

/**
 * Publish this round's live answers as last-seen snapshots (called once from
 * the converged tail of a staged run, behind the finalized response). Only
 * merchants that answered with at least one offer write; a silent pass simply
 * leaves the previous snapshot in place. Rows missing a hop stamp get this
 * round's completion time so every snapshot row can render its collection
 * clock honestly. Best-effort: never rejects.
 */
export async function rememberRound(
  query: string,
  settled: ReadonlyArray<{ merchant: string; hits: SearchHit[] }>,
  now: number = Date.now(),
  dir?: string,
): Promise<void> {
  try {
    const iso = new Date(now).toISOString();
    const answered = settled.filter((s) => s.hits.length > 0);
    if (answered.length === 0) return;
    const kv = getSharedKv();
    if (kv) {
      await Promise.all(
        answered.map((s) => {
          const entry: LastSeenEntry = { collectedAt: iso, hits: boundedHits(s.hits, iso) };
          return kv.set(lastSeenKey(s.merchant, query), JSON.stringify(entry), KV_TTL_S);
        }),
      );
      return;
    }
    const table = pruneTable(readTable(dir), now);
    for (const s of answered) {
      table[lastSeenKey(s.merchant, query)] = { collectedAt: iso, hits: boundedHits(s.hits, iso) };
    }
    writeTable(table, dir);
  } catch {
    /* best-effort — the live path is unaffected by a snapshot hiccup */
  }
}

function boundedHits(hits: SearchHit[], iso: string): SearchHit[] {
  return hits.slice(0, MAX_SNAPSHOT_OFFERS).map((h) => (h.collectedAt ? h : { ...h, collectedAt: iso }));
}

/**
 * Fill the merchants whose LIVE pass stayed silent: their last-seen rows,
 * marked so they render below the live offers with their snapshot clock. With
 * live hits present nothing is read at all (AC: fallback never competes with
 * live answers). Entries older than 24 h are dropped here even when the store
 * kept them; rows keep their ORIGINAL hop stamps, so the label shows the true
 * collection time, never a re-stamped "now". Never throws.
 */
export async function fillSilentFromLastSeen(
  query: string,
  country: CountryCode | null,
  settled: ReadonlyArray<{ merchant: string; hits: SearchHit[] }>,
  now: number = Date.now(),
  dir?: string,
): Promise<SearchHit[]> {
  const missing = settled.filter((s) => s.hits.length === 0);
  if (missing.length === 0) return [];
  const rows: SearchHit[] = [];
  try {
    const kv = getSharedKv();
    await Promise.all(
      missing.map(async (s) => {
        const key = lastSeenKey(s.merchant, query);
        let entry: LastSeenEntry | null = null;
        if (kv) {
          const raw = await kv.get(key);
          entry = raw ? asEntry(JSON.parse(raw)) : null;
        }
        if (!entry) entry = asEntry(readTable(dir)[key]);
        if (!entry) return;
        const t = Date.parse(entry.collectedAt);
        if (Number.isNaN(t) || now - t > LAST_SEEN_MAX_AGE_MS) return;
        for (const h of entry.hits) {
          if (country && h.country !== country) continue;
          rows.push({ ...h, collectedAt: h.collectedAt ?? entry.collectedAt, fromSnapshot: true });
        }
      }),
    );
  } catch {
    /* best-effort — a snapshot miss just leaves the column as-is */
  }
  return rows;
}

/** Test/admin helper: clear the degraded disk layer. */
export function resetLastSeenForTests(dir?: string): void {
  try {
    rmSync(diskFile(dir), { force: true });
  } catch {
    /* nothing to clean */
  }
}
