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
}: {
  collectedAt: string;
  method: "live" | "cache";
}) {
  const age = relativeAge(collectedAt);
  return (
    <p
      className="mt-2 flex items-center gap-2"
      style={{ font: "var(--r2-text-12)", color: "var(--r2-muted)" }}
    >
      {method === "live" && age !== null && <span className="live-dot" aria-hidden />}
      <span>
        {age !== null ? `Collected ${age}` : "Collection time unknown"}
        {" · "}
        {method === "live" ? "live" : "cached"}
      </span>
    </p>
  );
}

export default function OfferCard({
  merchant,
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
        <h3 style={{ font: "var(--r2-text-16)", fontWeight: 600, color: "var(--r2-ink)" }}>
          {merchant}
        </h3>
        {isBest && (
          <span
            className="label-token rounded px-2 py-0.5"
            style={{
              background: "var(--r2-deal-bg)",
              color: "var(--r2-deal)",
              borderRadius: "var(--r2-radius-control)",
            }}
          >
            Best price
          </span>
        )}
      </div>

      <p className="tabular mt-1" style={{ font: "var(--r2-text-price)", color: "var(--r2-ink)" }}>
        {priceLabel}
      </p>
      {effectivePriceLabel && (
        <p className="tabular" style={{ font: "var(--r2-text-14)", color: "var(--r2-deal)" }}>
          {effectivePriceLabel} with coupon
        </p>
      )}
      {isBest && savings && (
        <p className="tabular" style={{ font: "var(--r2-text-14)", color: "var(--r2-deal)" }}>
          Save {savings} vs highest
        </p>
      )}

      <p className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className="label-token rounded px-2 py-0.5"
          style={{
            background: inStock ? "var(--r2-deal-bg)" : "var(--r2-error-bg)",
            color: inStock ? "var(--r2-deal)" : "var(--r2-error)",
            borderRadius: "var(--r2-radius-control)",
          }}
        >
          {inStock ? "In stock" : "Out of stock"}
        </span>
        {coupon && (
          <span
            className="rounded px-2 py-0.5"
            style={{
              font: "var(--r2-text-12)",
              background: "var(--r2-warn-bg)",
              color: "var(--r2-warn)",
              borderRadius: "var(--r2-radius-control)",
            }}
          >
            {coupon.code ? `${coupon.code} — ` : ""}
            {coupon.discount}
          </span>
        )}
      </p>

      {/* D-AC3 / plan AC4: provenance on EVERY offer card render. */}
      <ProvenanceLine collectedAt={collectedAt} method={method} />

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
