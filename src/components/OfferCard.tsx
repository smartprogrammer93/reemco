import { useEffect, useState } from "react";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { isTenMinutesOld, relativeAge } from "@/lib/relative-time";
import { formatPrice } from "@/lib/format";
import type { Coupon } from "@/types/product";

/**
 * Design v3 offer card (design-v3 §5.2–§5.5), paired with realtime-policy §6.
 * Price hierarchy (§5.3): retailer label → chips → EFFECTIVE PRICE (the largest
 * element, ≥28px tabular) → strikethrough compare-at beside it → savings pill
 * directly after the price. Best offer keeps elev-2 + the "Best price" flag;
 * its CTA is filled, everyone else's is outline. Coupon pill shows the VALUE
 * only (§5.4). Freshness/provenance chip (§5.5): dot + relative time + retailer
 * — green dot < 10 min, amber thereafter; never omitted. Savings render only
 * when computable — never invented.
 */

export interface OfferCardProps {
  merchant: string;
  /** Retailer domain shown on the provenance line. */
  domain?: string;
  priceLabel: string;
  /** Effective (coupon-applied) price label — shown under the hero price. */
  effectivePriceLabel?: string;
  /** Higher listed price for the strikethrough beside the effective price. */
  compareAtLabel?: string;
  coupon?: Coupon;
  inStock: boolean;
  url: string;
  /** ISO 8601 collection timestamp from the offer provenance metadata. */
  collectedAt: string;
  method: "live" | "cache";
  isBest: boolean;
  /** Human absolute savings (e.g. "KWD 12.40") — null hides the pill entirely. */
  savings: string | null;
  /** Raw numeric price for the Arrival count-up; label falls back otherwise. */
  price?: number;
  currency?: string;
}

/**
 * Arrival count-up (Brief v4 signature moment): the price animates to its
 * final value over ~200ms as the card lands, then settles on the exact
 * scraped figure. With prefers-reduced-motion it simply shows the final
 * label — the count-up is a flourish, never a data delay: the final value
 * renders first and only animates on top of it.
 */
function CountUpPrice({
  priceLabel,
  price,
  currency,
}: {
  priceLabel: string;
  price: number;
  currency: string;
}) {
  const [shown, setShown] = useState(priceLabel);
  const [lastPriceLabel, setLastPriceLabel] = useState(priceLabel);
  // Guarded render-time adjustment (react.dev pattern): when the scraped label
  // changes, the final value resets during render — the count-up below then
  // animates on top of it. Replaces the synchronous setState in the effect body.
  if (lastPriceLabel !== priceLabel) {
    setLastPriceLabel(priceLabel);
    setShown(priceLabel);
  }
  useEffect(() => {
    if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const DURATION_MS = 200;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out, lands exactly on price
      setShown(formatPrice(price * eased, currency));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [priceLabel, price, currency]);
  return <>{shown}</>;
}

function FreshnessChip({
  collectedAt,
  method,
  merchant,
}: {
  collectedAt: string;
  method: "live" | "cache";
  merchant: string;
}) {
  const age = relativeAge(collectedAt);
  const late = age !== null && isTenMinutesOld(collectedAt);
  // §5.5 wording: fresh arrivals read "updated just now"; older keep the age.
  const freshSeconds = age !== null && /^\d+s ago$/.test(age);
  const timePart = age === null ? null : freshSeconds ? "just now" : age;
  return (
    <p className="mt-2">
      <span className="fresh-chip">
        <span className={`fresh-dot${late ? " is-late" : ""}`} aria-hidden />
        <span>
          {timePart !== null ? `updated ${timePart} · ${merchant}` : merchant} ·{" "}
          {method === "live" ? "live" : "cached"}
        </span>
      </span>
    </p>
  );
}

export default function OfferCard({
  merchant,
  domain,
  priceLabel,
  price,
  currency,
  effectivePriceLabel,
  compareAtLabel,
  coupon,
  inStock,
  url,
  collectedAt,
  method,
  isBest,
  savings,
}: OfferCardProps) {
  return (
    <article className={`result-card${isBest ? " is-best" : ""}`}>
      {/* Retailer name first, calm (§5.3 order) */}
      <p className="label-token" style={{ color: "var(--rc-muted)" }}>
        {merchant}
        {domain ? ` · ${domain}` : ""}
      </p>

      {/* Chips row: availability + coupon value (§5.4) */}
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <span className="savings-pill" style={!inStock ? { background: "var(--rc-error-bg)", color: "var(--rc-error)" } : undefined}>
          {inStock ? "In stock" : "Out of stock"}
        </span>
        {coupon && (
          <span className="coupon-badge">
            {coupon.discount}
          </span>
        )}
      </p>

      {/* Price block: effective price is the loudest element (P1 / AC-6) */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tabular" style={{ font: "var(--rc-text-price)", color: "var(--rc-ink)" }}>
          {price != null ? (
            <CountUpPrice priceLabel={priceLabel} price={price} currency={currency ?? "KWD"} />
          ) : (
            priceLabel
          )}
        </span>
        {compareAtLabel && (
          <span
            className="tabular"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", textDecoration: "line-through" }}
          >
            {compareAtLabel}
          </span>
        )}
        {isBest && savings && <span className="savings-pill">Save {savings}</span>}
      </div>
      {effectivePriceLabel && (
        <p className="tabular mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-savings)" }}>
          Effective {effectivePriceLabel} with coupon
        </p>
      )}

      {isBest && (
        <p className="mt-2">
          <span className="best-flag">Best price</span>
        </p>
      )}

      {/* Provenance chip (§5.5): dot + time + retailer + live|cache label. */}
      <FreshnessChip collectedAt={collectedAt} method={method} merchant={merchant} />

      <TrackedOutboundLink
        href={url}
        query=""
        rank={0}
        itemId={merchant}
        className={`${isBest ? "r2-btn" : "btn-outline focusable"} mt-3 min-h-11 w-full px-4 py-2`}
      >
        View at {merchant}
      </TrackedOutboundLink>
    </article>
  );
}
