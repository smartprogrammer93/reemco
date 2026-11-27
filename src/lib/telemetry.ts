/**
 * REEA-37 — client telemetry (no cookies, no localStorage, no PII).
 *
 * Fire-and-forget beacons to the same-origin ingestion endpoint. Each call
 * is independent; no identifiers are created, stored, or reused (AC-3).
 * Failures are silently dropped — instrumentation must never break UX.
 */
import type { EventType } from "@/lib/events";
import { CTR_EVENT_TYPES, MAX_EVENTS_PER_REQUEST, V1_EVENT_TYPES } from "@/lib/events";
import { isBotUserAgent } from "@/lib/bot-ua";

export type ClientEvent = {
  type: EventType;
  query?: string;
  result_count?: number;
  rank?: number;
  item_id?: string;
  outbound_url?: string;
  // REEA-965 v1 properties (R2 spec FR-3 table) — camelCase per spec.
  schema?: number;
  queryId?: string;
  relatedCount?: number;
  offerId?: string;
  retailer?: string;
  position?: number;
  hasCoupon?: boolean;
  priceSanityStatus?: string | null;
};

const ENDPOINT = "/api/events";

/**
 * REEA-965 — split a batch into ingestion-sized chunks. The endpoint caps a
 * request at MAX_EVENTS_PER_REQUEST events and counts the overflow as
 * rejected, so a large render batch (offer_rendered per card) must ride
 * several beacons or its tail is silently dropped.
 */
function chunkEvents(events: ClientEvent[]): ClientEvent[][] {
  const chunks: ClientEvent[][] = [];
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
    chunks.push(events.slice(i, i + MAX_EVENTS_PER_REQUEST));
  }
  return chunks;
}

export function trackEvents(events: ClientEvent[]): void {
  if (typeof window === "undefined" || events.length === 0) return;
  // REEA-981 (AC-4, R2 spec FR-3.2) — bot/health-check traffic contributes
  // zero events to any rate the FR-4 read uses. The server render tail gates
  // on the SAME shared predicate; this is the client half of the same gate,
  // placed at the single transport chokepoint so every current and future
  // client emitter (offer_rendered/coupon_hit, result/first_result/related
  // clicks) is covered without each surface re-deciding. Only the v1 metrics
  // stream is filtered: the REEA-37 funnel contract is explicitly out of the
  // events spec's scope (REEA-973 §3 non-goal), so funnel beacons pass
  // unchanged and the funnel counters keep their existing semantics.
  //
  // REEA-1237 — the page_view CTR beacon joins the filtered set. It is CTR
  // instrumentation, not a funnel event, so a headless QA/smoke probe (which
  // DOES execute JS, unlike a crawler) must not inflate the shopper CTR
  // denominator: the whole point of the shopper basis is that a bot serve is
  // not a shopper serve. The click numerator stays the unfiltered funnel
  // stream (REEA-973), so a bot that clicks without a counted view is the
  // only asymmetry left — QA click volume is negligible beside shopper
  // views, and it can only make the published CTR a slight over-estimate.
  if (isBotUserAgent(typeof navigator === "undefined" ? null : navigator.userAgent)) {
    const filteredTypes: readonly string[] = [...V1_EVENT_TYPES, ...CTR_EVENT_TYPES];
    events = events.filter((e) => !filteredTypes.includes(e.type));
    if (events.length === 0) return;
  }
  for (const chunk of chunkEvents(events)) {
    sendChunk(chunk);
  }
}

function sendChunk(events: ClientEvent[]): void {
  const body = JSON.stringify({ events });
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))
    ) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // instrumentation must never throw into the UI
  }
}

export function trackEvent(event: ClientEvent): void {
  trackEvents([event]);
}
