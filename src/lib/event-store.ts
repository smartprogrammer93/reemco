/**
 * REEA-37 — server-side funnel event store.
 *
 * Append-only JSONL file (one event per line) with 90-day raw retention:
 * events older than MAX_AGE_DAYS are pruned on read/report; only weekly
 * aggregates outlive that (Data Minimization). No PII is stored — the
 * rate-limit key (client IP) lives only in process memory, never on disk.
 *
 * Server-only module (imports node:fs); never import from client code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FunnelEvent } from "@/lib/events";

export const MAX_AGE_DAYS = 90;

function defaultEventsDir(): string {
  if (process.env.EVENTS_DIR) return process.env.EVENTS_DIR;
  // Serverless (Vercel/Lambda) filesystems are read-only except /tmp, and
  // /tmp is ephemeral per warm instance — acceptable for the minimal funnel
  // until a durable store lands (see REEA-37 follow-up).
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

/** Append validated events, assigning a random id and server timestamp to each. */
export function appendEvents(
  events: Omit<FunnelEvent, "id" | "ts">[],
  opts: { now?: number; dir?: string } = {},
): FunnelEvent[] {
  const now = opts.now ?? Date.now();
  const stamped: FunnelEvent[] = events.map((e) => ({
    ...e,
    id: randomUUID(),
    ts: new Date(now).toISOString(),
  }));
  const dir = opts.dir ?? EVENTS_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(eventsFile(dir), stamped.map((e) => JSON.stringify(e)).join("\n") + "\n", {
    flag: "a",
  });
  return stamped;
}

/** Read all retained events, skipping corrupt lines. Does not prune. */
export function readEvents(dir = EVENTS_DIR): FunnelEvent[] {
  let text: string;
  try {
    text = readFileSync(eventsFile(dir), "utf8");
  } catch {
    return [];
  }
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

/** Drop raw events older than the retention window; rewrites the file when pruning. */
export function pruneOldEvents(
  opts: { now?: number; maxAgeDays?: number; dir?: string } = {},
): number {
  const dir = opts.dir ?? EVENTS_DIR;
  const cut = cutoffMs(opts.now ?? Date.now(), opts.maxAgeDays ?? MAX_AGE_DAYS);
  const events = readEvents(dir);
  const kept = events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cut;
  });
  if (kept.length === events.length) return 0;
  mkdirSync(dir, { recursive: true });
  const tmp = eventsFile(dir) + ".tmp";
  writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
  renameSync(tmp, eventsFile(dir));
  return events.length - kept.length;
}
