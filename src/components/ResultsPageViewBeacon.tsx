"use client";
/**
 * REEA-1237 — the client page-view beacon for the shopper CTR basis.
 *
 * Why this exists: the offer-link CTR numerator is a browser click beacon
 * (`item_clicked`), while the old denominator was a SERVER serve count that
 * also counted crawler fetches that never executed the page. Mixing the two
 * made CTR unreadable (W48: 5 clicks / 24,509 server serves = 0.02%). This
 * component fires ONE `page_view` beacon per served results page from the
 * shopper's own browser, so the denominator is on the same basis as the
 * numerator: a browser that actually executed the page.
 *
 * Dedupe: the server generates a fresh random `serveKey` (the REEA-965
 * per-query-execution `queryId`) for every render. One key = one serve, so a
 * client-side re-render of the same serve never double-fires, while a new
 * query, a refresh or a back-navigation (a new server render) fires again —
 * exactly one beacon per serve. The key is used ONLY as local memory; it is
 * not sent with the event, so nothing per-user or per-query is persisted.
 *
 * Bot gate: `trackEvents` drops `page_view` for the shared bot/health-check
 * User-Agent predicate (lib/bot-ua.ts), so headless QA/smoke probes — which
 * do execute JS — never inflate the shopper denominator. Non-JS crawlers
 * never reach a beacon at all.
 *
 * Non-visual: renders nothing. Fire-and-forget; a lost beacon degrades the
 * aggregate count, never the page.
 */
import { useEffect, useRef } from "react";
import { trackEvent } from "@/lib/telemetry";

export default function ResultsPageViewBeacon({ serveKey }: { serveKey: string }) {
  // Component-local memory only — no cookie, no localStorage, no session id.
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!serveKey || firedRef.current === serveKey) return;
    firedRef.current = serveKey;
    trackEvent({ type: "page_view" });
  }, [serveKey]);
  return null;
}
