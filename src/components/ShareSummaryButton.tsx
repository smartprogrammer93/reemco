"use client";

import { useRef, useState } from "react";
import type { CountryCode } from "@/lib/country";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";
import { buildShareSummary } from "@/lib/share-summary";
import { trackEvent } from "@/lib/telemetry";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-541 Bet B — one-tap shareable comparison summary on the product card
 * and the detail page (both ride ProductResultCard). The click builds the line
 * from the SAME props the rows render from — sortOffers order, country-led
 * figures, first five offers, freshness bucket tail — so a copied line always
 * matches what the shopper just saw, honoring the live country/stock
 * selections (they arrive already applied on the props, REEA-291 chain).
 *
 * AC4 contract: navigator.clipboard first; when it is unavailable (insecure
 * context) or rejects, fall back to select-on-click — a temporary textarea is
 * selected and copied through the legacy command, then removed. No persistent
 * client state: the copied ✓ is component-local transient feedback on the
 * CouponBadge pattern; the event fires through the shared REEA-37 beacon
 * (server assigns id/ts; nothing is read back here).
 */
export default function ShareSummaryButton({
  product,
  query = "",
  country = null,
  locale,
  iconOnly = false,
}: {
  product: NormalizedProduct;
  /** REEA-37 funnel context; "" on the detail page (see copySummary). */
  query?: string;
  /** REEA-170 country selection — decides the lead currency on each figure. */
  country?: CountryCode | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /** Direction A card-media overlay: a 44x44 icon button, same action. */
  iconOnly?: boolean;
}) {
  const loc = locale ?? clientLocale();
  const t = getStrings(loc);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** AC4 fallback: select the built line on click and copy it. */
  function copyWithSelect(text: string): void {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      // still no clipboard path — the line can always be selected manually
    }
  }

  async function copySummary(): Promise<void> {
    // Built at click time from the current props: a selection change re-renders
    // the card with the refiltered product, and the next copy follows it — the
    // button itself keeps no stored summary.
    const text = buildShareSummary(product, { locale: loc, country, now: Date.now() });
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        copyWithSelect(text);
      }
    } catch {
      copyWithSelect(text);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
    // REEA-541 AC3 — anonymous summary_copied event. The detail page carries no
    // query string; the product's own title names what was compared, so the
    // event stays attributable without inventing a new field.
    trackEvent({ type: "summary_copied", query: query || product.title, item_id: product.productId });
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={copySummary}
        aria-label={t.shareSummaryAria}
        className="rc-icon-btn focusable"
        style={{ background: "var(--rc-surface)", border: "1px solid var(--rc-line)" }}
      >
        {copied ? (
          <span aria-hidden>✓</span>
        ) : (
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={copySummary}
      aria-label={t.shareSummaryAria}
      className="query-pill query-pill-on-light focusable ms-auto shrink-0 whitespace-nowrap"
    >
      {copied ? "✓" : t.copyLabel}
    </button>
  );
}
