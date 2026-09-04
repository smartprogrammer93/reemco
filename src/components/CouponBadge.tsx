"use client";

import { useRef, useState } from "react";
import type { Coupon } from "@/types/product";

/**
 * F3 CouponBadge: 1px dashed green border on green tint, radius 8,
 * 6px×10px padding. One badge per card; caller collapses extras.
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
      <span className="label-token" style={{ color: "var(--brand-green)" }}>
        Coupon
      </span>
      <span className="text-[13px] font-medium" style={{ color: "var(--brand-green)" }}>
        {coupon.discount}
      </span>
      {coupon.code && (
        <>
          <code
            className="rounded px-1 text-[13px]"
            style={{
              fontFamily: "var(--font-geist-mono), monospace",
              color: "var(--brand-ink)",
            }}
          >
            {coupon.code}
          </code>
          <button
            type="button"
            onClick={copyCode}
            aria-label={`Copy coupon code ${coupon.code}`}
            className="flex h-8 w-8 items-center justify-center rounded border text-xs"
            style={{
              borderColor: "var(--brand-border)",
              color: "var(--brand-slate-600)",
              minHeight: 32,
              minWidth: 32,
            }}
          >
            {copied ? (
              <span style={{ color: "var(--brand-green)" }}>Copied</span>
            ) : (
              "Copy"
            )}
          </button>
        </>
      )}
    </span>
  );
}
