"use client";

import { useRef, useState } from "react";
import type { Coupon } from "@/types/product";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/**
 * Design v3 §5.4 coupon pill: amber, coupon VALUE only ("5 KWD off",
 * "FREE ship"). One coupon per card; the code + copy affordance stay for
 * usability, rendered inside the pill at small size. Label-only text — no
 * countdowns, no fake urgency. REEA-279: the chrome labels come from the
 * static string table via the resolved locale.
 */
export default function CouponBadge({
  coupon,
  locale,
}: {
  coupon: Coupon;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
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
    <span className="coupon-badge inline-flex items-center gap-2 whitespace-nowrap">
      <span>{`${t.couponLead} ${coupon.discount}`}</span>
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
            aria-label={`${t.copyAriaLead} ${coupon.code}`}
            className="focusable flex h-8 w-8 items-center justify-center rounded border"
            style={{ borderColor: "var(--rc-fresh)", color: "var(--rc-fresh)" }}
          >
            {copied ? (
              <span style={{ font: "var(--rc-text-small)" }}>✓</span>
            ) : (
              <span style={{ font: "var(--rc-text-small)" }}>{t.copyLabel}</span>
            )}
          </button>
        </>
      )}
    </span>
  );
}
