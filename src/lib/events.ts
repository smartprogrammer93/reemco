/**
 * REEA-37 — anonymous funnel event schema.
 *
 * Five funnel events, all anonymous: no cookies, no sessions, no PII, no
 * persistent identifiers. Event ids are random per event and assigned
 * server-side on ingestion (client-supplied id/ts are ignored).
 *
 * Security lenses: Input validation (allowlist/bounds, AC-6), Data
 * minimization (only known fields kept, 90-day raw retention).
 */
import { z } from "zod";

export const EVENT_TYPES = [
  "search_submitted",
  "result_impressed",
  "item_clicked",
  "zero_results",
  // REEA-541 Bet B — the share-summary Copy button fired once per copy.
  "summary_copied",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface FunnelEvent {
  id: string; // random per event, assigned by the ingestion endpoint
  ts: string; // ISO 8601, assigned by the ingestion endpoint
  type: EventType;
  query: string;
  result_count?: number; // search_submitted
  rank?: number; // result_impressed / item_clicked
  item_id?: string; // result_impressed / item_clicked
  outbound_url?: string; // item_clicked
}

// C0 controls + DEL stripped from client-supplied free text.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const querySchema = z
  .string()
  .max(200)
  .transform((s) => s.replace(CONTROL_CHARS, "").trim())
  .refine((s) => s.length > 0, "query required after sanitization");

const safeUrlSchema = z
  .string()
  .max(2048)
  .refine((s) => !CONTROL_CHARS.test(s), "control characters in URL")
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "outbound_url must be an absolute http(s) URL");

const baseShape = {
  type: z.enum(EVENT_TYPES),
  query: querySchema,
  result_count: z.number().int().min(0).max(100_000).optional(),
  rank: z.number().int().min(-1).max(100_000).optional(),
  item_id: z
    .string()
    .max(100)
    .transform((s) => s.replace(CONTROL_CHARS, "").trim())
    .refine((s) => s.length > 0, "item_id required after sanitization")
    .optional(),
  outbound_url: safeUrlSchema.optional(),
};

const eventSchema = z.object(baseShape).superRefine((ev, ctx) => {
  const need = (cond: boolean, msg: string, path: string) => {
    if (!cond) ctx.addIssue({ code: "custom", message: msg, path: [path] });
  };
  switch (ev.type) {
    case "search_submitted":
      need(ev.result_count !== undefined, "result_count required", "result_count");
      break;
    case "result_impressed":
      need(ev.rank !== undefined, "rank required", "rank");
      need(ev.item_id !== undefined, "item_id required", "item_id");
      break;
    case "item_clicked":
      need(ev.rank !== undefined, "rank required", "rank");
      need(ev.item_id !== undefined, "item_id required", "item_id");
      need(ev.outbound_url !== undefined, "outbound_url required", "outbound_url");
      break;
    case "zero_results":
      break;
    case "summary_copied":
      // No extra fields: query (+ optional item_id) is the whole event.
      break;
  }
});

export type RawEvent = z.input<typeof eventSchema>;

export type EventValidation =
  | { ok: true; event: Omit<FunnelEvent, "id" | "ts"> }
  | { ok: false; error: string };

/** Validate one client-supplied event. Returns a normalized event or a reason. */
export function validateEvent(raw: unknown): EventValidation {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const { type, query, result_count, rank, item_id, outbound_url } = parsed.data;
  return { ok: true, event: { type, query, result_count, rank, item_id, outbound_url } };
}

/** Ingestion payload: a single event or a batch (bounded). */
export const MAX_EVENTS_PER_REQUEST = 20;

export function validateEventBatch(
  body: unknown,
): {
  accepted: Omit<FunnelEvent, "id" | "ts">[];
  rejected: number;
} {
  const events = (body as { events?: unknown } | null)?.events;
  const list = Array.isArray(events) ? events : [body];
  const accepted: Omit<FunnelEvent, "id" | "ts">[] = [];
  let rejected = 0;
  for (const item of list.slice(0, MAX_EVENTS_PER_REQUEST)) {
    const res = validateEvent(item);
    if (res.ok) accepted.push(res.event);
    else rejected += 1;
  }
  return { accepted, rejected: rejected + Math.max(0, list.length - MAX_EVENTS_PER_REQUEST) };
}
