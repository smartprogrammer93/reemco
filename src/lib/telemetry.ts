/**
 * REEA-37 — client telemetry (no cookies, no localStorage, no PII).
 *
 * Fire-and-forget beacons to the same-origin ingestion endpoint. Each call
 * is independent; no identifiers are created, stored, or reused (AC-3).
 * Failures are silently dropped — instrumentation must never break UX.
 */
import type { EventType } from "@/lib/events";

export type ClientEvent = {
  type: EventType;
  query: string;
  result_count?: number;
  rank?: number;
  item_id?: string;
  outbound_url?: string;
};

const ENDPOINT = "/api/events";

export function trackEvents(events: ClientEvent[]): void {
  if (typeof window === "undefined" || events.length === 0) return;
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
