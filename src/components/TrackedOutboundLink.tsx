"use client";

import type { ReactNode } from "react";
import { trackEvent } from "@/lib/telemetry";

/**
 * REEA-37 — outbound merchant link that fires an anonymous item_clicked
 * event (query, rank, item_id, outbound_url) on click (AC-2). Navigation is
 * never delayed or blocked; the beacon uses sendBeacon/keepalive fetch.
 */
export default function TrackedOutboundLink({
  href,
  query,
  rank,
  itemId,
  children,
  className,
  style,
}: {
  href: string;
  query: string;
  rank: number;
  itemId: string;
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
      }}
    >
      {children}
    </a>
  );
}
