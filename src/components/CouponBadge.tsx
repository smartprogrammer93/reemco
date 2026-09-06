"use client";

import { useRef, useState } from "react";
import type { Coupon } from "@/types/product";

/**
 * Design v3 §5.4 coupon pill: amber, coupon VALUE only ("5 KWD off",
 * "FREE ship"). One coupon per card; the code + copy affordance stay for
 * usability, rendered inside the pill at small size. Label-only text — no
 * countdowns, no fake urgency.
 */
export default function CouponBadge({ coupon }: { coupon: Coupon }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyCode() {
    if (!coupon.code) return;
    try {
      await navigator.clipboard.writeText(coupon.code);
    } catch {
      // clipboard unavailable (e.g. insecure context); still show feedback
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <span className="coupon-badge inline-flex items-center gap-2">
      <span>{coupon.discount}</span>
      {coupon.code && (
        <>
          <code
            className="rounded px-1"
            style={{ fontFamily: "var(--rc-font-mono), monospace", fontSize: 13, fontWeight: 600 }}
          >
            {coupon.code}
          </code>
          <button
            type="button"
            onClick={copyCode}
            aria-label={`Copy coupon code ${coupon.code}`}
            className="focusable flex h-8 w-8 items-center justify-center rounded border"
            style={{ borderColor: "var(--rc-fresh)", color: "var(--rc-fresh)" }}
          >
            {copied ? (
              <span style={{ font: "var(--rc-text-small)" }}>✓</span>
            ) : (
              <span style={{ font: "var(--rc-text-small)" }}>Copy</span>
            )}
          </button>
        </>
      )}
    </span>
  );
}
