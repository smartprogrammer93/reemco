"use client";

import type { ReactNode } from "react";
import { trackEvents, trackEvent } from "@/lib/telemetry";
import { buildFirstResultClick, buildResultClick } from "@/lib/metrics-events";

/**
 * REEA-37 — outbound merchant link that fires an anonymous item_clicked
 * event (query, rank, item_id, outbound_url) on click (AC-2). Navigation is
 * never delayed or blocked; the beacon uses sendBeacon/keepalive fetch.
 *
 * REEA-965 — when a v1 metrics context rides the link (results-page offers;
 * the server render's per-query `queryId` + the card's position), the click
 * ALSO fires the spec-table `result_click` (+ `first_result_click` on the
 * first primary card, position 1) in the same fire-and-forget turn.
 * AC-9: the onClick handler only calls the non-blocking beacon helpers —
 * no await, no navigation delay. Surfaces without a queryId (product detail
 * pages, collection diagnostics) keep the REEA-37 event only. `position` is
 * the card's 1-based primary position (rank + 1) — one card, several offer
 * rows, each row click attributes to the card it renders on. No PII: the
 * only identifier in any payload is the per-query random queryId (AC-8).
 */
export default function TrackedOutboundLink({
  href,
  query,
  rank,
  itemId,
  queryId,
  retailer,
  children,
  className,
  style,
}: {
  href: string;
  query: string;
  rank: number;
  itemId: string;
  /** REEA-965 v1 context — present only on results-page offer links. */
  queryId?: string;
  /** The merchant this link leads to (the click's `retailer` property). */
  retailer?: string;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={style}
      onClick={() => {
        trackEvent({
          type: "item_clicked",
          query,
          rank,
          item_id: itemId,
          outbound_url: href,
        });
        if (queryId && retailer && rank >= 0) {
          const position = rank + 1;
          const events = [buildResultClick({ queryId, offerId: itemId, retailer, position })];
          if (rank === 0) {
            events.push(buildFirstResultClick({ queryId, offerId: itemId, retailer }));
          }
          trackEvents(events);
        }
      }}
    >
      {children}
    </a>
  );
}
