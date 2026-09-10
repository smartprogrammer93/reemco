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
import { SEEN_WINDOW_MS, type SeenRow } from "@/lib/seen-range";
import type { SearchHit } from "@/lib/collect/live-search";

/** A snapshot stays servable for one day; past it the read drops the entry. */
export const LAST_SEEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Rows kept per retailer+query — bounded, the adapter's own best-first order. */
export const MAX_SNAPSHOT_OFFERS = 10;
/** REEA-540 — day slots kept per merchant+query: exactly the Bet A window. */
export const MAX_SEEN_DAYS = 14;
/** Bounded disk layer: oldest-first eviction, same ceiling as the memo. */
const MAX_SNAPSHOT_ENTRIES = 250;
/**
 * REEA-540 — storage retention for the whole entry. The REEA-510 fill stays
 * a ≤24 h promise (checked on READ, untouched above); the RETENTION only
 * decides how long the stored entry survives, so the bounded per-day history
 * the confidence line reads can span its 14-day window between quiet spells.
 */
const SEEN_RETENTION_MS = SEEN_WINDOW_MS + LAST_SEEN_MAX_AGE_MS;
const KV_TTL_S = Math.ceil(SEEN_RETENTION_MS / 1000);

/** One merchant-day observation slot (REEA-540 Bet A roll-up source). */
interface SeenDay {
  /** ISO stamp of the round that recorded it ("latest per day wins"). */
  observedAt: string;
  /** Offer figures of that day's round, kept in their scraped native form. */
  offers: { price: number; currency: string; country: CountryCode }[];
}

interface LastSeenEntry {
  /** ISO stamp of the LIVE round that produced this snapshot (age basis). */
  collectedAt: string;
  hits: SearchHit[];
  /**
   * REEA-540 — bounded per-day history for the confidence-line roll-up: at
   * most MAX_SEEN_DAYS slots, one per calendar day, the latest round of that
   * day wins. Entries written before this field existed simply carry their
   * single `hits` round (derived on read below). No new collection rides on
   * it — same rounds, same rows as the snapshot above.
   */
  days?: SeenDay[];
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

/**
 * Drop entries whose LAST WRITE aged past the storage retention (the REEA-510
 * ≤24 h servability itself is checked on READ in fillSilentFromLastSeen),
 * then evict oldest-first past the bounded ceiling. REEA-540: the retention
 * spans the day-history window, so a merchant+query keeps its observations
 * while it is queried at least once per retention period.
 */
function pruneTable(table: LastSeenTable, now: number): LastSeenTable {
  const fresh: LastSeenTable = {};
  for (const [key, entry] of Object.entries(table)) {
    const t = Date.parse(entry?.collectedAt ?? "");
    if (!Number.isNaN(t) && now - t <= SEEN_RETENTION_MS) fresh[key] = entry;
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
        answered.map(async (s) => {
          const key = lastSeenKey(s.merchant, query);
          // Read-modify-write so the day history accumulates across rounds
          // (REEA-540). kv.get is already best-effort (null on miss/hiccup).
          const raw = await kv.get(key);
          const prev = raw ? asEntry(JSON.parse(raw)) : null;
          const entry: LastSeenEntry = { collectedAt: iso, hits: boundedHits(s.hits, iso), days: mergeDays(prev, daySlot(s.hits, iso)) };
          await kv.set(key, JSON.stringify(entry), KV_TTL_S);
        }),
      );
      return;
    }
    const table = pruneTable(readTable(dir), now);
    for (const s of answered) {
      const key = lastSeenKey(s.merchant, query);
      const entry: LastSeenEntry = { collectedAt: iso, hits: boundedHits(s.hits, iso), days: mergeDays(table[key], daySlot(s.hits, iso)) };
      table[key] = entry;
    }
    writeTable(table, dir);
  } catch {
    /* best-effort — the live path is unaffected by a snapshot hiccup */
  }
}

/** Calendar day of a round stamp (UTC date part of the ISO string). */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function daySlot(hits: SearchHit[], iso: string): SeenDay[] {
  return [
    {
      observedAt: iso,
      offers: boundedHits(hits, iso).map((h) => ({ price: h.price, currency: h.currency, country: h.country })),
    },
  ];
}

/** Pre-REEA-540 entries carry only the single `hits` round — derive its slot. */
function legacySlots(entry: LastSeenEntry | null | undefined): SeenDay[] {
  if (!entry || entry.days?.length) return entry?.days ?? [];
  const t = Date.parse(entry.collectedAt);
  if (Number.isNaN(t)) return entry.days ?? [];
  return [
    {
      observedAt: entry.collectedAt,
      offers: entry.hits.map((h) => ({ price: h.price, currency: h.currency, country: h.country })),
    },
  ];
}

/**
 * Merge one round into the bounded day history: one slot per calendar day,
 * the latest round of that day wins (AC3's dedup rule, applied at write time
 * as well as on read), and only the MAX_SEEN_DAYS most recent days are kept.
 */
function mergeDays(prev: LastSeenEntry | null | undefined, today: SeenDay[]): SeenDay[] {
  const byDay = new Map<string, SeenDay>();
  for (const slot of legacySlots(prev)) {
    const day = dayOf(slot.observedAt);
    if (!byDay.has(day)) byDay.set(day, slot);
  }
  for (const slot of today) byDay.set(dayOf(slot.observedAt), slot);
  return [...byDay.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-MAX_SEEN_DAYS);
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

/**
 * REEA-540 Bet A — read the CURRENT QUERY's stored observations for the
 * roll-up: every merchant-day slot inside the rolling window, flattened to
 * per-offer rows. Reads exactly the keys the snapshots above already write
 * (`seen:<merchant>:<query>`), from KV first and the degraded disk layer as
 * the fallback — no new collection, no second hop anywhere. Slots whose day
 * is outside the window are dropped; rows of the selected country only when
 * a selection is active (same rule as fillSilentFromLastSeen). Best-effort:
 * KV hiccups degrade to whatever layer answers, never to a failed request.
 */
export async function readSeenObservations(
  query: string,
  merchants: ReadonlyArray<string>,
  opts: { country?: CountryCode | null; now?: number; dir?: string } = {},
): Promise<SeenRow[]> {
  const now = opts.now ?? Date.now();
  const country = opts.country ?? null;
  const rows: SeenRow[] = [];
  try {
    const kv = getSharedKv();
    await Promise.all(
      merchants.map(async (merchant) => {
        const key = lastSeenKey(merchant, query);
        let entry: LastSeenEntry | null = null;
        if (kv) {
          const raw = await kv.get(key);
          entry = raw ? asEntry(JSON.parse(raw)) : null;
        }
        if (!entry) entry = asEntry(opts.dir === undefined ? readTable()[key] : readTable(opts.dir)[key]);
        if (!entry) return;
        for (const slot of legacySlots(entry)) {
          const t = Date.parse(slot.observedAt);
          if (Number.isNaN(t) || now - t > SEEN_WINDOW_MS || t > now) continue;
          const day = dayOf(slot.observedAt);
          for (const o of slot.offers) {
            if (country && o.country !== country) continue;
            rows.push({ merchant, day, observedAt: slot.observedAt, price: o.price, currency: o.currency, country: o.country });
          }
        }
      }),
    );
  } catch {
    /* best-effort — a thin observation set just means a thinner confidence line */
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
