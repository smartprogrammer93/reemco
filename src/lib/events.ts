/**
 * REEA-37 — anonymous funnel event schema.
 *
 * Five funnel events, all anonymous: no cookies, no sessions, no PII, no
 * persistent identifiers. Event ids are random per event and assigned
 * server-side on ingestion (client-supplied id/ts are ignored).
 *
 * Security lenses: Input validation (allowlist/bounds, AC-6), Data
 * minimization (only known fields kept, 90-day raw retention).
 *
 * REEA-965 — relevance/coupon metrics events, schema version 1 (R2 spec
 * FR-3): seven event types with the exact property names the spec table
 * pins (camelCase, `schema: 1`). Same store, same retention, same
 * fire-and-forget ingestion as the REEA-37 funnel — one sink, two schemas.
 * Data minimization is contractual for v1 (spec §7, QA launch blocker):
 * a per-query-execution random `queryId` is the ONLY identifier any v1
 * event carries — no user id, session id, IP, or fingerprint field exists
 * in the schema, and unknown client-supplied fields are stripped at
 * validation.
 */
import { z } from "zod";

/** REEA-37 funnel events (snake_case property contract, unchanged). */
export const FUNNEL_EVENT_TYPES = [
  "search_submitted",
  "result_impressed",
  "item_clicked",
  "zero_results",
  // REEA-541 Bet B — the share-summary Copy button fired once per copy.
  "summary_copied",
] as const;

/**
 * REEA-965 v1 metrics events (R2 spec FR-3 table, verbatim names):
 * - search_performed / zero_result_shown fire server-side per query render;
 * - first_result_click / result_click fire on primary-result card clicks;
 * - related_click fires on related-accessory card clicks (the R2 related
 *   section, REEA-964 — the schema ships here so the section can emit from
 *   day one);
 * - offer_rendered / coupon_hit fire once per rendered results set.
 */
export const V1_EVENT_TYPES = [
  "search_performed",
  "zero_result_shown",
  "first_result_click",
  "result_click",
  "related_click",
  "offer_rendered",
  "coupon_hit",
] as const;

/** REEA-965 — the only v1 schema version this build speaks. */
export const V1_SCHEMA_VERSION = 1;

export const EVENT_TYPES = [...FUNNEL_EVENT_TYPES, ...V1_EVENT_TYPES] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type V1EventType = (typeof V1_EVENT_TYPES)[number];

export interface FunnelEvent {
  id: string; // random per event, assigned by the ingestion endpoint
  ts: string; // ISO 8601, assigned by the ingestion endpoint
  type: EventType;
  query?: string; // funnel events + v1 search_performed / zero_result_shown
  result_count?: number; // search_submitted / search_performed (camelCase resultCount below)
  rank?: number; // result_impressed / item_clicked
  item_id?: string; // result_impressed / item_clicked
  outbound_url?: string; // item_clicked
  // REEA-965 v1 properties — exact spec-table names (camelCase).
  schema?: number; // always 1 on v1 events
  queryId?: string; // per-query-execution random id — the only v1 identifier
  resultCount?: number; // search_performed (funnel search_submitted keeps result_count)
  relatedCount?: number; // search_performed / zero_result_shown
  offerId?: string; // result/related clicks, coupon_hit
  retailer?: string; // clicks, offer_rendered, coupon_hit
  position?: number; // result_click / first_result_click (1-based)
  hasCoupon?: boolean; // offer_rendered
  priceSanityStatus?: string | null; // offer_rendered — R1 flag; null until R1 lands
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
  query: querySchema.optional(),
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

// REEA-965 v1 field schemas — same sanitization discipline as the funnel
// fields (bounds + control-char strip). queryId is opaque random; it is NOT
// validated as a UUID because it only ever needs to join events, and
// over-validation would reject future id formats for no privacy gain.
const queryIdShape = z
  .string()
  .max(64)
  .transform((s) => s.replace(CONTROL_CHARS, "").trim())
  .refine((s) => s.length > 0, "queryId required after sanitization");
const tokenShape = (label: string) =>
  z
    .string()
    .max(100)
    .transform((s) => s.replace(CONTROL_CHARS, "").trim())
    .refine((s) => s.length > 0, `${label} required after sanitization`);
const retailerShape = tokenShape("retailer");
const offerIdShape = tokenShape("offerId");
// R1 flag annotation; null until R1 lands (spec: emit null, don't block).
const priceSanityShape = z
  .union([
    z.string().max(32).transform((s) => s.replace(CONTROL_CHARS, "").trim()),
    z.null(),
  ])
  .refine((s) => s === null || s.length > 0, "priceSanityStatus empty string not allowed");

const eventSchema = z
  .object({ type: z.enum(FUNNEL_EVENT_TYPES), ...baseShape })
  .superRefine((ev, ctx) => {
  const need = (cond: boolean, msg: string, path: string) => {
    if (!cond) ctx.addIssue({ code: "custom", message: msg, path: [path] });
  };
  switch (ev.type) {
    case "search_submitted":
      need(ev.query !== undefined, "query required", "query");
      need(ev.result_count !== undefined, "result_count required", "result_count");
      break;
    case "result_impressed":
      need(ev.query !== undefined, "query required", "query");
      need(ev.rank !== undefined, "rank required", "rank");
      need(ev.item_id !== undefined, "item_id required", "item_id");
      break;
    case "item_clicked":
      need(ev.query !== undefined, "query required", "query");
      need(ev.rank !== undefined, "rank required", "rank");
      need(ev.item_id !== undefined, "item_id required", "item_id");
      need(ev.outbound_url !== undefined, "outbound_url required", "outbound_url");
      break;
    case "zero_results":
      need(ev.query !== undefined, "query required", "query");
      break;
    case "summary_copied":
      // No extra fields: query (+ optional item_id) is the whole event.
      need(ev.query !== undefined, "query required", "query");
      break;
    // REEA-965 v1 types are discriminated in v1EventSchema below.
  }
});

/**
 * REEA-965 — v1 event schema. Each type carries exactly the properties the
 * R2 spec table pins (plus `schema: 1`); anything else the client sends is
 * stripped (data minimization — the stored payload is the validated shape).
 */
const v1EventSchema = z
  .object({
    type: z.enum(V1_EVENT_TYPES),
    ...baseShape,
    schema: z.literal(V1_SCHEMA_VERSION),
    queryId: queryIdShape.optional(),
    resultCount: z.number().int().min(0).max(100_000).optional(),
    relatedCount: z.number().int().min(0).max(100_000).optional(),
    offerId: offerIdShape.optional(),
    retailer: retailerShape.optional(),
    position: z.number().int().min(1).max(100_000).optional(),
    hasCoupon: z.boolean().optional(),
    priceSanityStatus: priceSanityShape.optional(),
  })
  .superRefine((ev, ctx) => {
  const need = (cond: boolean, msg: string, path: string) => {
    if (!cond) ctx.addIssue({ code: "custom", message: msg, path: [path] });
  };
  switch (ev.type) {
    case "search_performed":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.query !== undefined, "query required", "query");
      need(ev.resultCount !== undefined, "resultCount required", "resultCount");
      need(ev.relatedCount !== undefined, "relatedCount required", "relatedCount");
      break;
    case "zero_result_shown":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.query !== undefined, "query required", "query");
      need(ev.relatedCount !== undefined, "relatedCount required", "relatedCount");
      break;
    case "first_result_click":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.offerId !== undefined, "offerId required", "offerId");
      need(ev.retailer !== undefined, "retailer required", "retailer");
      need(ev.position === 1, "first_result_click position must be 1", "position");
      break;
    case "result_click":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.offerId !== undefined, "offerId required", "offerId");
      need(ev.retailer !== undefined, "retailer required", "retailer");
      need(ev.position !== undefined, "position required", "position");
      break;
    case "related_click":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.offerId !== undefined, "offerId required", "offerId");
      need(ev.retailer !== undefined, "retailer required", "retailer");
      break;
    case "offer_rendered":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.retailer !== undefined, "retailer required", "retailer");
      need(ev.hasCoupon !== undefined, "hasCoupon required", "hasCoupon");
      need(ev.priceSanityStatus !== undefined, "priceSanityStatus required (null until R1)", "priceSanityStatus");
      break;
    case "coupon_hit":
      need(ev.queryId !== undefined, "queryId required", "queryId");
      need(ev.retailer !== undefined, "retailer required", "retailer");
      need(ev.offerId !== undefined, "offerId required", "offerId");
      break;
  }
});

export type RawEvent = z.input<typeof eventSchema>;

export type EventValidation =
  | { ok: true; event: Omit<FunnelEvent, "id" | "ts"> }
  | { ok: false; error: string };

/** Validate one client-supplied event. Returns a normalized event or a reason. */
export function validateEvent(raw: unknown): EventValidation {
  const funnel = eventSchema.safeParse(raw);
  if (funnel.success) {
    const { type, query, result_count, rank, item_id, outbound_url } = funnel.data;
    return { ok: true, event: { type, query, result_count, rank, item_id, outbound_url } };
  }
  const v1 = v1EventSchema.safeParse(raw);
  if (v1.success) {
    const {
      type,
      query,
      schema,
      queryId,
      resultCount,
      relatedCount,
      offerId,
      retailer,
      position,
      hasCoupon,
      priceSanityStatus,
    } = v1.data;
    return {
      ok: true,
      event: {
        type,
        query,
        schema,
        queryId,
        resultCount,
        relatedCount,
        offerId,
        retailer,
        position,
        hasCoupon,
        priceSanityStatus,
      },
    };
  }
  const errors = [...funnel.error.issues, ...v1.error.issues];
  return { ok: false, error: errors.map((i) => i.message).join("; ") };
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
