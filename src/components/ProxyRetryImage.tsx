"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

/**
 * REEA-1128 — a proxied retailer photo that heals itself after a refusal wave.
 *
 * The results card hands Shopify product photos to the same-origin
 * `/api/image` proxy (see src/lib/image-proxy.ts). That route always answers
 * 200 — the real image when the retailer CDN co-operates, and a 1x1-intrinsic
 * SVG category glyph when it refuses — so the shopper never sees a broken
 * icon and the browser never logs `Failed to load resource: 403` (the
 * REEA-1118 guardrail).
 *
 * The refusal is measured as an intermittent WAVE, not a permanent block: the
 * same URL answers 200 minutes later. A single server-side retry budget
 * cannot ride out a multi-second wave without leaving the card frame blank,
 * so the route degrades to the glyph quickly and THIS component re-requests
 * the URL on a backoff. A miss is detectable from the decoded image itself:
 * the glyph has `naturalWidth === 1` while a real product photo is wider. The
 * retry URL carries a distinct `&r=` stamp so the browser's 30 s glyph cache
 * and the route's in-process cache cannot answer it from the stale miss.
 *
 * Hydration safety: the first render is identical on the server and on the
 * client (`attempt` starts at 0), and no clock, locale or random value is
 * read during render.
 */

/** Retry cadence. The last attempt lands ~13 s after the first paint, which is
 *  past the measured refusal window without hammering the upstream. */
const RETRY_DELAYS_MS = [1200, 3500, 8000] as const;

type Props = {
  /** Already-proxied `/api/image?u=…` source (isProxiedImageSrc). */
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
};

export default function ProxyRetryImage({ src, alt, width, height, className, style }: Props) {
  const [attempt, setAttempt] = useState(0);
  const timerRef = useRef<number | null>(null);

  // A pending retry must not fire after unmount (the results grid re-renders
  // on every filter change).
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const scheduleRetry = useCallback(() => {
    if (attempt >= RETRY_DELAYS_MS.length) return;
    if (timerRef.current !== null) return; // already scheduled for this attempt
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setAttempt((a) => a + 1);
    }, RETRY_DELAYS_MS[attempt]);
  }, [attempt]);

  const settle = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const img = event.currentTarget;
      // A decoded product photo is wider than the proxy's 1x1 miss glyph. An
      // error (route 5xx, dropped connection) also lands here with width 0.
      if (img.complete && img.naturalWidth > 1) return;
      scheduleRetry();
    },
    [scheduleRetry],
  );

  const currentSrc = attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}r=${attempt}`;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={currentSrc}
      alt={alt}
      width={width}
      height={height}
      className={className}
      style={style}
      onLoad={settle}
      onError={settle}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
    />
  );
}
