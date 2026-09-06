"use client";

import type { CollectJob, LiveOffer, RetailerSubtask } from "@/lib/collect/types";
import { jobProgress } from "@/lib/collect-progress";
import { effectivePrice, formatPrice } from "@/lib/format";
import type { Coupon } from "@/types/product";
import OfferCard from "@/components/OfferCard";

/**
 * Design v3 "Aurora" collection-progress moment (design-v3 §5.6 paired with
 * realtime-policy §6). A slim rail of outlined retailer chips; each chip fills
 * with the brand color and pulses once as its retailer's offers land; landed
 * offer cards rise in below. The rail collapses once every slot is settled.
 * Progress derives only from REAL per-retailer subtask states — never synthetic
 * timers. Reduced motion keeps opacity fades only (§5.7).
 */

function RetailerChip({
  subtask,
  onRetry,
}: {
  subtask: RetailerSubtask;
  onRetry?: (retailer: string) => void;
}) {
  const { status, retailer, offersFound, error } = subtask;
  const failed = status === "failed" || status === "timeout";
  return (
    <li className={`rc-chip is-${status}`} data-status={status} title={error}>
      {status === "collecting" && <span className="pulse-spinner" aria-hidden />}
      {status === "done" && <span aria-hidden>✓</span>}
      <span>{retailer}</span>
      {status === "done" && offersFound > 0 && (
        <span className="tabular">
          {offersFound} {offersFound === 1 ? "offer" : "offers"}
        </span>
      )}
      {failed && <span>{status === "timeout" ? "Timed out" : "Failed"}</span>}
      {/* Failure always pairs with a per-slot retry affordance — never blanks
          the rest of the page (realtime-policy §4 failure ladder). */}
      {failed && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(retailer)}
          className="hover:underline"
          style={{ font: "inherit", color: "inherit" }}
        >
          Retry
        </button>
      )}
    </li>
  );
}

/**
 * Cascading offer cards rendered per retailer AS IT LANDS (§5.6 arrival).
 * NOTE: LiveOffer does not yet carry a coupon field (W1 gap, flagged on
 * REEA-88) — the extension is optional here so the cascade works either way.
 */
export function PulseOfferCascade({
  offers,
}: {
  offers: (LiveOffer & { coupon?: Coupon })[];
}) {
  const prices = offers.map((o) => o.price);
  const best = Math.min(...prices);
  const worst = Math.max(...prices);
  return (
    <ul className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-[repeat(2,minmax(0,1fr))]">
      {offers.map((offer, i) => {
        const eff = effectivePrice(offer, offer.coupon);
        return (
          <li
            key={`${offer.merchant}-${offer.url}`}
            className="pulse-cascade"
            style={{ "--cascade-index": i } as React.CSSProperties}
          >
            <OfferCard
              merchant={offer.merchant}
              domain={offer.domain}
              priceLabel={formatPrice(offer.price, offer.currency)}
              effectivePriceLabel={eff !== null ? formatPrice(eff, offer.currency) : undefined}
              compareAtLabel={
                offer.wasPrice != null && offer.wasPrice > offer.price
                  ? formatPrice(offer.wasPrice, offer.currency)
                  : undefined
              }
              coupon={offer.coupon}
              inStock={offer.inStock}
              url={offer.url}
              collectedAt={offer.collectedAt}
              method={offer.method}
              isBest={offer.price === best}
              savings={
                offer.price === best && worst > best
                  ? formatPrice(worst - best, offer.currency)
                  : null
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

export default function CollectionPulse({
  job,
  elapsedLabel,
  onRetryRetailer,
}: {
  job: CollectJob;
  /** Human elapsed time, e.g. "12s" — computed by the caller from startedAt. */
  elapsedLabel?: string;
  /** Per-retailer retry — wired by the panel to the collect-job retry API. */
  onRetryRetailer?: (retailer: string) => void;
}) {
  const progress = Math.round(jobProgress(job) * 100);
  const settled = job.status !== "collecting";
  return (
    <section aria-label="Collecting live offers" aria-busy={!settled}>
      {!settled && (
        <>
          <div
            className="pulse-bar"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="pulse-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <p
            className="mt-2 flex items-center justify-between"
            style={{ font: "var(--rc-text-body)", color: "var(--rc-muted)" }}
          >
            <span>Collecting live offers…</span>
            <span className="tabular">{elapsedLabel}</span>
          </p>
          <ul className="rc-chip-rail mt-2">
            {job.subtasks.map((s: RetailerSubtask) => (
              <RetailerChip key={s.retailer} subtask={s} onRetry={onRetryRetailer} />
            ))}
          </ul>
        </>
      )}
      {settled && job.status === "complete" && (
        <p
          className="mt-1 flex items-center gap-2"
          style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}
        >
          <span className="live-dot" aria-hidden />
          Collection complete
        </p>
      )}
    </section>
  );
}
