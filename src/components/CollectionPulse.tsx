"use client";

import type { CollectJob, LiveOffer, RetailerSubtask } from "@/lib/collect/types";
import { jobProgress } from "@/lib/collect-progress";
import { effectivePrice, formatPrice } from "@/lib/format";
import type { Coupon } from "@/types/product";
import OfferCard from "@/components/OfferCard";

/**
 * "Reemco Pulse" — the signature collection moment (REEA-84 plan §2.6,
 * REEA-90 C8). Full-width header progress bar with pulse sheen; per-retailer
 * rows flip skeleton → spinner → check / red chip as the REAL job subtasks
 * resolve. Progress derives only from W1 job states (plan AC2) — no synthetic
 * timers. On completion the bar snaps green and offer cards cascade in
 * (staggered 40ms, disabled under prefers-reduced-motion).
 */

function RetailerRow({ subtask }: { subtask: RetailerSubtask }) {
  const { status, retailer, offersFound, error } = subtask;
  return (
    <li
      className="flex items-center gap-3 py-1.5"
      style={{ font: "var(--r2-text-14)", color: "var(--r2-body)" }}
      data-status={status}
    >
      {status === "pending" && <span className="r2-skeleton inline-block h-3.5 w-14" aria-hidden />}
      {status === "collecting" && <span className="pulse-spinner" aria-hidden />}
      {status === "done" && (
        <span aria-hidden style={{ color: "var(--r2-deal)" }}>
          ✓
        </span>
      )}
      {(status === "failed" || status === "timeout") && (
        <span
          className="label-token rounded px-2 py-0.5"
          style={{
            background: "var(--r2-error-bg)",
            color: "var(--r2-error)",
            borderRadius: "var(--r2-radius-control)",
          }}
        >
          {status === "timeout" ? "Timed out" : "Failed"}
        </span>
      )}
      <span>{retailer}</span>
      {status === "done" && offersFound > 0 && (
        <span className="tabular" style={{ color: "var(--r2-muted)" }}>
          {offersFound} {offersFound === 1 ? "offer" : "offers"}
        </span>
      )}
      {(status === "failed" || status === "timeout") && error && (
        <span style={{ color: "var(--r2-muted)" }}>{error}</span>
      )}
    </li>
  );
}

/**
 * Cascading offer cards shown once the run completes (§2.6).
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
    <ul className="mt-4 grid gap-3">
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
              priceLabel={formatPrice(offer.price, offer.currency)}
              effectivePriceLabel={eff !== null ? formatPrice(eff, offer.currency) : undefined}
              coupon={offer.coupon}
              inStock={offer.inStock}
              url={offer.url}
              collectedAt={offer.collectedAt}
              method={offer.method}
              isBest={offer.price === best}
              savings={offer.price === best && worst > best ? formatPrice(worst - best, offer.currency) : null}
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
}: {
  job: CollectJob;
  /** Human elapsed time, e.g. "12s" — computed by the caller from startedAt. */
  elapsedLabel?: string;
}) {
  const progress = Math.round(jobProgress(job) * 100);
  const settled = job.status !== "collecting";
  return (
    <section aria-label="Collecting live offers" aria-busy={!settled}>
      <div className="pulse-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <div className={`pulse-bar-fill${settled ? " is-done" : ""}`} style={{ width: `${progress}%` }} />
      </div>
      <p
        className="mt-2 flex items-center justify-between"
        style={{ font: "var(--r2-text-14)", color: "var(--r2-muted)" }}
      >
        <span>{settled ? "Collection complete" : "Collecting live offers…"}</span>
        <span className="tabular">{elapsedLabel}</span>
      </p>
      <ul className="mt-2">
        {job.subtasks.map((s: RetailerSubtask) => (
          <RetailerRow key={s.retailer} subtask={s} />
        ))}
      </ul>
    </section>
  );
}
