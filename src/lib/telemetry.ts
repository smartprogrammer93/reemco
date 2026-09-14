/**
 * REEA-37 — client telemetry (no cookies, no localStorage, no PII).
 *
 * Fire-and-forget beacons to the same-origin ingestion endpoint. Each call
 * is independent; no identifiers are created, stored, or reused (AC-3).
 * Failures are silently dropped — instrumentation must never break UX.
 */
import type { EventType } from "@/lib/events";
import { MAX_EVENTS_PER_REQUEST } from "@/lib/events";

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
