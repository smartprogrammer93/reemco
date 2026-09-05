import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { relativeAge } from "@/lib/relative-time";
import type { Coupon } from "@/types/product";

/**
 * Theme v2 offer card (REEA-84 plan §2.3, REEA-90 C7).
 * Price is the hero (28px tabular); best offer gets a green "Best price"
 * badge + green border; savings line only when computable (never invented);
 * availability pill; amber coupon chip; MANDATORY provenance line
 * "Collected Xs ago · live|cache" (D-AC3 / plan AC4).
 */

export interface OfferCardProps {
  merchant: string;
  /** Retailer domain shown on the provenance line (G1 §4.2). */
  domain?: string;
  priceLabel: string;
  /** Effective (coupon-applied) price label — shown under the hero price. */
  effectivePriceLabel?: string;
  coupon?: Coupon;
  inStock: boolean;
  url: string;
  /** ISO 8601 collection timestamp from the offer provenance metadata. */
  collectedAt: string;
  method: "live" | "cache";
  isBest: boolean;
  /** Human absolute savings (e.g. "€12.40") — null hides the line entirely. */
  savings: string | null;
}

function ProvenanceLine({
  collectedAt,
  method,
  domain,
}: {
  collectedAt: string;
  method: "live" | "cache";
  domain?: string;
}) {
  const age = relativeAge(collectedAt);
  return (
    <p
      className="mt-2 flex items-center gap-2"
      style={{ font: "var(--rc-text-12)", color: "var(--rc-muted)" }}
    >
      {method === "live" && age !== null && <span className="live-dot" aria-hidden />}
      <span>
        {age !== null ? `Collected ${age}` : "Collection time unknown"}
        {" · "}
        {method === "live" ? "live" : "cached"}
        {domain ? ` · ${domain}` : ""}
      </span>
    </p>
  );
}

export default function OfferCard({
  merchant,
  domain,
  priceLabel,
  effectivePriceLabel,
  coupon,
  inStock,
  url,
  collectedAt,
  method,
  isBest,
  savings,
}: OfferCardProps) {
  return (
    <article className={`r2-card p-4${isBest ? " is-best" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 style={{ font: "var(--rc-text-16)", fontWeight: 600, color: "var(--rc-ink)" }}>
          {merchant}
        </h3>
        {isBest && (
          <span
            className="label-token rounded px-2 py-0.5"
            style={{
              background: "var(--rc-savings-tint)",
              color: "var(--rc-savings-on-tint)",
              borderRadius: "var(--rc-radius-control)",
            }}
          >
            Best price
          </span>
        )}
      </div>

      <p
        className="tabular mt-1"
        style={{
          font: "var(--rc-text-price)",
          color: isBest ? "var(--rc-savings)" : "var(--rc-ink)",
          fontWeight: isBest ? 700 : undefined,
        }}
      >
        {priceLabel}
      </p>
      {effectivePriceLabel && (
        <p className="tabular" style={{ font: "var(--rc-text-14)", color: "var(--rc-savings)" }}>
          {effectivePriceLabel} with coupon
        </p>
      )}
      {isBest && savings && (
        <p className="tabular" style={{ font: "var(--rc-text-14)", color: "var(--rc-savings)" }}>
          Save {savings} vs highest
        </p>
      )}

      <p className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className="label-token rounded px-2 py-0.5"
          style={{
            background: inStock ? "var(--rc-savings-tint)" : "var(--rc-error-tint)",
            color: inStock ? "var(--rc-savings-on-tint)" : "var(--rc-error-on-tint)",
            borderRadius: "var(--rc-radius-control)",
          }}
        >
          {inStock ? "In stock" : "Out of stock"}
        </span>
        {coupon && (
          <span
            className="rounded px-2 py-0.5"
            style={{
              font: "var(--rc-text-12)",
              background: "var(--rc-stale-tint)",
              color: "var(--rc-stale-on-tint)",
              border: "1px dashed var(--rc-stale)",
              borderRadius: "var(--rc-radius-control)",
            }}
          >
            {coupon.code ? `${coupon.code} — ` : ""}
            {coupon.discount}
          </span>
        )}
      </p>

      {/* D-AC3 / plan AC4: provenance on EVERY offer card render. */}
      <ProvenanceLine collectedAt={collectedAt} method={method} domain={domain} />

      <TrackedOutboundLink
        href={url}
        query=""
        rank={0}
        itemId={merchant}
        className="r2-btn mt-3 w-full px-4 py-2"
      >
        View at retailer
      </TrackedOutboundLink>
    </article>
  );
}
