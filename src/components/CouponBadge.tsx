"use client";

import { useRef, useState } from "react";
import type { Coupon } from "@/types/product";

/**
 * Theme v1 §3.3 CouponBadge: dashed deal border on deal tint, mono code,
 * 32×32 copy hit area with focus ring. Label-only text — no countdowns,
 * no fake urgency.
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
      <span className="label-token" style={{ color: "var(--color-deal)" }}>
        Coupon {coupon.discount}
      </span>
      {coupon.code && (
        <>
          <code
            className="rounded px-1"
            style={{
              font: "13px/18px var(--font-mono)",
              color: "var(--color-deal)",
            }}
          >
            {coupon.code}
          </code>
          <button
            type="button"
            onClick={copyCode}
            aria-label={`Copy coupon code ${coupon.code}`}
            className="focusable flex h-8 w-8 items-center justify-center rounded border"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-ink-secondary)",
            }}
          >
            {copied ? (
              <span style={{ color: "var(--color-deal)", font: "var(--text-small)" }}>✓</span>
            ) : (
              <span style={{ font: "var(--text-small)" }}>Copy</span>
            )}
          </button>
        </>
      )}
    </span>
  );
}
