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
}: {
  product: NormalizedProduct;
  /** REEA-37 funnel context; "" on the detail page (see copySummary). */
  query?: string;
  /** REEA-170 country selection — decides the lead currency on each figure. */
  country?: CountryCode | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
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

  return (
    <button
      type="button"
      onClick={copySummary}
      aria-label={t.shareSummaryAria}
      className="query-pill query-pill-on-light focusable ml-auto shrink-0 whitespace-nowrap"
    >
      {copied ? "✓" : t.copyLabel}
    </button>
  );
}
