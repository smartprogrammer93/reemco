/**
 * REEA-37 — server-side funnel event store. REEA-233 — durable retention.
 *
 * Append-only JSONL with 90-day raw retention: events older than
 * MAX_AGE_DAYS are pruned on read/report; only weekly aggregates outlive
 * that (Data Minimization). No PII is stored — the rate-limit key
 * (client IP) lives only in process memory, never on disk.
 *
 * Cross-instance durability (REEA-233): on Vercel each serverless instance
 * gets its own /tmp, so a disk-only store answers only for the current warm
 * instance and the weekly window never accumulates scheduled runs. When the
 * shared KV binding exists (see collect/kv.ts) the store mirrors the JSONL
 * there — same read-through + best-effort contract as the collect-job store:
 * a KV hiccup degrades to the local disk layer, never to a failed request.
 * Reads merge both layers and dedupe by event id, so an event counts once no
 * matter which instance wrote it. Without a KV binding (local dev, tests)
 * behavior is unchanged: the per-process disk cache is the whole store.
 *
 * Event shapes are unchanged; this is retention plumbing only.
 *
 * Server-only module (imports node:fs); never import from client code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FunnelEvent } from "@/lib/events";
import { getSharedKv, type SharedKv } from "@/lib/collect/kv";

export const MAX_AGE_DAYS = 90;

/** Shared-KV key holding the whole JSONL blob (single funnel, single key). */
export const EVENTS_KV_KEY = "events:jsonl";

/** Outlive the raw retention window a little so TTL alone never drops a
 *  window that pruning would still keep. */
export const EVENTS_KV_TTL_S = (MAX_AGE_DAYS + 7) * 24 * 60 * 60;

function defaultEventsDir(): string {
  if (process.env.EVENTS_DIR) return process.env.EVENTS_DIR;
  // Serverless (Vercel/Lambda) filesystems are read-only except /tmp, and
  // /tmp is ephemeral per warm instance — with a KV binding it is the local
  // layer the shared blob merges with (see REEA-233 note above).
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "/tmp/reemco-events";
  }
  return join(process.cwd(), ".events");
}

export const EVENTS_DIR = defaultEventsDir();

function eventsFile(dir = EVENTS_DIR): string {
  return join(dir, "events.jsonl");
}

function cutoffMs(now: number, maxAgeDays = MAX_AGE_DAYS): number {
  return now - maxAgeDays * 24 * 60 * 60 * 1000;
}

/** Resolve the shared store; an injected instance (tests) wins. */
function sharedKv(opts: { kv?: SharedKv | null } = {}): SharedKv | null {
  if (opts.kv !== undefined) return opts.kv;
  return getSharedKv();
}

function parseLines(text: string): FunnelEvent[] {
  const out: FunnelEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as FunnelEvent;
      if (typeof e?.type === "string" && typeof e?.ts === "string") out.push(e);
    } catch {
      // corrupt line — drop, don't fail the report
    }
  }
  return out;
}

/** Dedupe key: the per-event random id, or a content fallback for legacy
 *  lines written before ids were stamped. */
function eventKey(e: FunnelEvent): string {
  if (typeof e.id === "string" && e.id) return `#${e.id}`;
  return `@${e.ts}|${e.type}|${e.query ?? ""}`;
}

/** First-wins merge of two layers, deduped so an event mirrored to KV and
 *  still present on the local disk of the reading instance counts once. */
export function mergeEvents(primary: FunnelEvent[], secondary: FunnelEvent[]): FunnelEvent[] {
  const seen = new Set<string>();
  const out: FunnelEvent[] = [];
  for (const e of [...primary, ...secondary]) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function serialize(events: FunnelEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

function readLocal(dir: string): FunnelEvent[] {
  let text: string;
  try {
    text = readFileSync(eventsFile(dir), "utf8");
  } catch {
    return [];
  }
  return parseLines(text);
}

async function readShared(kv: SharedKv): Promise<FunnelEvent[]> {
  const raw = await kv.get(EVENTS_KV_KEY);
  return raw ? parseLines(raw) : [];
}

/** Append validated events, assigning a random id and server timestamp to each.
 *  Writes the local JSONL layer, then (when a shared store is bound) mirrors
 *  the merged whole back to KV so other instances see it on their next read. */
export async function appendEvents(
  events: Omit<FunnelEvent, "id" | "ts">[],
  opts: { now?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<FunnelEvent[]> {
  const now = opts.now ?? Date.now();
  const stamped: FunnelEvent[] = events.map((e) => ({
    ...e,
    id: randomUUID(),
    ts: new Date(now).toISOString(),
  }));
  const dir = opts.dir ?? EVENTS_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(eventsFile(dir), serialize(stamped), { flag: "a" });

  const kv = sharedKv(opts);
  if (kv && stamped.length > 0) {
    // Fold this instance's whole local layer (just appended to) into the
    // shared blob — dedup keeps the mirror idempotent across repeat uploads.
    const merged = mergeEvents(await readShared(kv), readLocal(dir));
    await kv.set(EVENTS_KV_KEY, serialize(merged), EVENTS_KV_TTL_S);
  }
  return stamped;
}

/** Read retained events from both layers (shared blob first, then local-only),
 *  skipping corrupt lines. Does not prune. */
export async function readEvents(
  opts: { dir?: string; kv?: SharedKv | null } = {},
): Promise<FunnelEvent[]> {
  const dir = opts.dir ?? EVENTS_DIR;
  const kv = sharedKv(opts);
  if (!kv) return readLocal(dir);
  return mergeEvents(await readShared(kv), readLocal(dir));
}

/** Drop raw events older than the retention window; rewrites the file when
 *  pruning, and rewrites the shared blob (shorter TTL-fresh body) when the
 *  shared layer holds expired lines. Returns the number of events dropped. */
export async function pruneOldEvents(
  opts: { now?: number; maxAgeDays?: number; dir?: string; kv?: SharedKv | null } = {},
): Promise<number> {
  const dir = opts.dir ?? EVENTS_DIR;
  const cut = cutoffMs(opts.now ?? Date.now(), opts.maxAgeDays ?? MAX_AGE_DAYS);
  let removed = pruneFile(eventsFile(dir), cut);

  const kv = sharedKv(opts);
  if (kv) {
    const shared = await readShared(kv);
    const kept = shared.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cut;
    });
    if (kept.length !== shared.length) {
      removed += shared.length - kept.length;
      await kv.set(EVENTS_KV_KEY, serialize(kept), EVENTS_KV_TTL_S);
    }
  }
  return removed;
}

function pruneFile(file: string, cut: number): number {
  const events = parseLines(tryRead(file));
  const kept = events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cut;
  });
  if (kept.length === events.length) return 0;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, serialize(kept));
    renameSync(tmp, file);
  } catch {
    /* best-effort — same contract as the KV layer */
  }
  return events.length - kept.length;
}

function tryRead(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
