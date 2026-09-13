"use client";

import {
  normalizedListingUrlOf,
  type CollectJob,
  type LiveOffer,
  type RetailerSubtask,
} from "@/lib/collect/types";
import { jobProgress } from "@/lib/collect-progress";
import { effectivePrice, effectivePriceKwd, formatPrimaryPrice } from "@/lib/format";
import type { Coupon } from "@/types/product";
import OfferCard from "@/components/OfferCard";
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";

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
  index,
  onRetry,
  locale,
}: {
  subtask: RetailerSubtask;
  index: number;
  onRetry?: (retailer: string) => void;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const { status, retailer, offersFound, error } = subtask;
  const failed = status === "failed" || status === "timeout";
  return (
    <li
      className={`rc-chip is-${status}`}
      data-status={status}
      title={error}
      style={{ "--cascade-index": index } as React.CSSProperties}
    >
      {status === "collecting" && <span className="pulse-spinner" aria-hidden />}
      {status === "done" && <span aria-hidden>✓</span>}
      <span>{retailer}</span>
      {status === "done" && offersFound > 0 && (
        <span className="tabular">
          {offersFound} {offersFound === 1 ? t.offerOne : t.offerMany}
        </span>
      )}
      {failed && <span>{status === "timeout" ? t.timedOut : t.failedLabel}</span>}
      {/* Failure always pairs with a per-slot retry affordance — never blanks
          the rest of the page (realtime-policy §4 failure ladder). */}
      {failed && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(retailer)}
          className="hover:underline"
          style={{ font: "inherit", color: "inherit" }}
        >
          {t.retry}
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
  locale,
}: {
  offers: (LiveOffer & { coupon?: Coupon })[];
  locale?: Locale;
}) {
  // REEA-604 — ONE normalized effective-price key (KWD-based, coupon/was-price
  // evidence folded) decides the best card and the savings gap across mixed
  // KWD/SAR offers: the badge lands on the cheapest-after-conversion listing,
  // not the smallest raw numeric. Pure arithmetic on the served figures, so
  // the same offer set always badges the same card.
  const keyed = offers.map((offer) => ({
    offer,
    effKey: effectivePriceKwd(offer.price, offer.currency, {
      wasPrice: offer.wasPrice,
      couponDiscount: offer.coupon?.discount ?? null,
    }),
  }));
  // REEA-908 spec §1/§6 — render-layer listing fold: the served invariant is
  // AT MOST ONE card per (merchant, normalized URL). The grouping fold
  // (live-search finalizeGroups) and the runner (uniqueListings /
  // appendUniqueOffers) already enforce it upstream; folding here too makes
  // the rendered page structurally immune to an upstream regression stacking
  // the same listing twice. Survivor rule per spec: the CHEAPEST occurrence
  // wins when the same listing lands twice with disagreeing prices, else the
  // first occurrence — rendered verbatim (no field merging), at the first
  // occurrence's position so the rendered order stays stable. Map iteration
  // is insertion-ordered and re-setting an existing key keeps its position,
  // which is exactly that survivor contract.
  const folded = new Map<string, (typeof keyed)[number]>();
  for (const k of keyed) {
    const id = `${k.offer.merchant}|${normalizedListingUrlOf(k.offer.url)}`;
    const at = folded.get(id);
    if (at === undefined || k.effKey < at.effKey) folded.set(id, k);
  }
  const unique = [...folded.values()];
  // The savings gap reads the RENDERED set only — a dropped duplicate must
  // never inflate `worst` (the cheapest/worst ends both come from cards that
  // actually render).
  const effs = unique.map((k) => k.effKey);
  // REEA-908 spec §2 — exactly ONE "Best price" badge per product page,
  // computed over IN-STOCK offers (fall back to the whole set only when every
  // card is out of stock), on the normalized comparable figure. A tie on the
  // lowest figure goes to the card that sorts first in the rendered list —
  // the badge index is picked once here, never per-card, so tied duplicates
  // of the same figure can never paint two badges.
  const stocked = unique.filter((k) => k.offer.inStock);
  const badgePool = stocked.length > 0 ? stocked : unique;
  const best = Math.min(...badgePool.map((k) => k.effKey));
  const bestIndex = unique.findIndex(
    (k) => k.effKey === best && (k.offer.inStock || stocked.length === 0),
  );
  const worst = Math.max(...effs);
  return (
    <ul className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-[repeat(2,minmax(0,1fr))]">
      {unique.map(({ offer }, i) => {
        const eff = effectivePrice(offer, offer.coupon);
        // REEA-195 AC-4: KWD-primary labels on the cascade cards too; the
        // count-up animates in the same KWD space it lands on.
        const hero = formatPrimaryPrice(offer.price, offer.currency);
        return (
          <li
            key={`${offer.merchant}-${offer.url}`}
            className="pulse-cascade"
            style={{ "--cascade-index": i } as React.CSSProperties}
          >
            <OfferCard
              merchant={offer.merchant}
              domain={offer.domain}
              price={hero.value}
              currency="KWD"
              priceLabel={hero.label}
              effectivePriceLabel={eff !== null ? formatPrimaryPrice(eff, offer.currency).label : undefined}
              compareAtLabel={
                offer.wasPrice != null && offer.wasPrice > offer.price
                  ? formatPrimaryPrice(offer.wasPrice, offer.currency).label
                  : undefined
              }
              coupon={offer.coupon}
              inStock={offer.inStock}
              url={offer.url}
              collectedAt={offer.collectedAt}
              method={offer.method}
              isBest={i === bestIndex}
              savings={
                // Both ends of the gap are KWD-space numbers — the pill prints
                // in the same KWD space the ranking uses.
                i === bestIndex && worst > best
                  ? formatPrimaryPrice(worst - best, "KWD").label
                  : null
              }
              locale={locale}
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
  locale,
}: {
  job: CollectJob;
  /** Human elapsed time, e.g. "12s" — computed by the caller from startedAt. */
  elapsedLabel?: string;
  /** Per-retailer retry — wired by the panel to the collect-job retry API. */
  onRetryRetailer?: (retailer: string) => void;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const progress = Math.round(jobProgress(job) * 100);
  const settled = job.status !== "collecting";
  // Warm Signal loading label: name the store being checked right now
  // ("Checking Jarir…") beside the amber sweep + the retailer count. Real
  // subtask states only — never synthetic progress.
  const active = job.subtasks.find((s) => s.status === "collecting");
  const checking =
    active?.retailer ?? job.subtasks.find((s) => s.status === "pending")?.retailer;
  const doneCount = job.subtasks.filter((s) => s.status === "done").length;
  return (
    <section aria-label={t.collectingAria} aria-busy={!settled}>
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
            className="mt-2 flex flex-wrap items-center justify-between gap-2"
            style={{ font: "var(--rc-text-body)", color: "var(--rc-muted)" }}
          >
            <span>{checking ? fill(t.checkingStore, { x: checking }) : t.checkingStores}</span>
            <span className="tabular">
              {doneCount}/{job.subtasks.length} {t.storesWord}
              {elapsedLabel ? ` · ${elapsedLabel}` : ""}
            </span>
          </p>
        </>
      )}
      {/* REEA-101 AC-5: the rail stays mounted once settled too. Production's
          synchronous ?wait=1 path delivers the snapshot already-complete, so a
          collapse-on-settle rail would never be visible at all; kept mounted,
          its chips carry the real per-retailer arrival states and pulse in on
          mount with the same stagger as the cards rising below. */}
      <ul className={`rc-chip-rail ${settled ? "mt-2" : ""}`}>
        {job.subtasks.map((s: RetailerSubtask, i: number) => (
          <RetailerChip key={s.retailer} subtask={s} index={i} onRetry={onRetryRetailer} locale={locale} />
        ))}
      </ul>
      {settled && job.status === "complete" && (
        <p
          className="mt-1 flex items-center gap-2"
          style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}
        >
          <span className="live-dot" aria-hidden />
          {t.collectionComplete}
        </p>
      )}
    </section>
  );
}
