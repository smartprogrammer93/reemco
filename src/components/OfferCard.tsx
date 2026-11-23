import { useEffect, useState } from "react";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import OfferCtaLabel from "@/components/OfferCtaLabel";
import { safeHref } from "@/lib/safe-url";
import { absoluteStamp, ageSeconds, isTenMinutesOld, relativeAge } from "@/lib/relative-time";
import { formatPrice } from "@/lib/format";
import type { Coupon } from "@/types/product";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";
import CouponLine from "@/components/CouponLine";

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
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /** REEA-283/REEA-1091 — the product page's baked server render clock. The
   *  streamed card derives its CTA age / freshness chip from it, so the
   *  served HTML and the hydration pass agree; without it the card falls back
   *  to Date.now() DURING render (React #418 on hydration). */
  renderStartMs?: number;
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
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const DURATION_MS = reduce ? 0 : 200;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = DURATION_MS === 0 ? 1 : Math.min(1, (t - start) / DURATION_MS);
      const eased = reduce ? 1 : 1 - Math.pow(1 - p, 3); // ease-out, lands exactly on price
      // Intermediate frames animate the numeric part; the final frame lands on
      // the exact served label (REEA-195: the label can carry the scraped-currency
      // stamp behind the KWD primary figure).
      setShown(p === 1 ? priceLabel : formatPrice(price * eased, currency));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [priceLabel, price, currency]);
  return <><bdi>{shown}</bdi></>;
}

function FreshnessChip({
  collectedAt,
  method,
  merchant,
  locale,
  renderStartMs,
}: {
  collectedAt: string;
  method: "live" | "cache";
  merchant: string;
  locale?: Locale;
  renderStartMs?: number;
}) {
  const t = getStrings(locale ?? clientLocale());
  // REEA-283/REEA-1091 — the baked clock is the single reference on the first
  // paint (the streamed card hydrates with the same value). An offer collected
  // inside the same render carries a stamp a beat AFTER renderStartMs, so the
  // reference floors at the stamp itself: the chip reads "updated just now"
  // instead of dropping the age (same Math.max discipline ageSeconds applies).
  const stampMs = Date.parse(collectedAt);
  const nowMs =
    renderStartMs == null
      ? undefined
      : Number.isNaN(stampMs)
        ? renderStartMs
        : Math.max(renderStartMs, stampMs);
  const age = relativeAge(collectedAt, nowMs);
  const late = age !== null && isTenMinutesOld(collectedAt, nowMs);
  // §5.5 wording: fresh arrivals read "updated just now"; older keep the age.
  const freshSeconds = age !== null && /^\d+s ago$/.test(age);
  const timePart = age === null ? null : freshSeconds ? t.justNow : age;
  // REEA-759 — the detail view pairs the scannable relative age with the
  // absolute collection moment ("when, exactly?"): same provenance line,
  // meta-stamp grammar, locale-invariant `YYYY-MM-DD HH:mm UTC` value,
  // <bdi>-isolated inside RTL chrome. Missing/invalid stamps render nothing
  // — never a fabricated moment.
  const abs = absoluteStamp(collectedAt);
  return (
    <p className="mt-2">
      <span className="fresh-chip">
        <span className={`fresh-dot${late ? " is-late" : ""}`} aria-hidden />
        <span>
          {timePart !== null ? `${t.updatedWord} ${timePart} · ${merchant}` : merchant} ·{" "}
          {method === "live" ? t.liveWord : t.cachedWord}
        </span>
      </span>
      {abs !== null && (
        <span className="meta-stamp mt-1 block" style={{ color: "var(--rc-muted)" }}>
          <bdi>{abs}</bdi>
        </span>
      )}
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
  locale,
  renderStartMs,
}: OfferCardProps) {
  // REEA-224 F2 — same render-time sanitization ProductResultCard applies via
  // resolveOfferUrl (REEA-13 allowlist): a crafted scheme lands as an empty
  // href instead of an inline-JavaScript anchor.
  const t = getStrings(locale ?? clientLocale());
  const href = safeHref(url) ?? "";
  return (
    <article className={`result-card${isBest ? " is-best" : ""}`}>
      {/* Retailer name first, calm (§5.3 order). REEA-451 F6 — the Latin name +
          domain ride a bidi isolate so RTL chrome never reorders them. */}
      <p className="label-token" style={{ color: "var(--rc-muted)" }}>
        <bdi>
          {merchant}
          {domain ? ` · ${domain}` : ""}
        </bdi>
      </p>

      {/* Chips row: availability only (§5.4) — REEA-760 moved the coupon
          evidence onto its own honest line below the price cluster. */}
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <span className="savings-pill" style={!inStock ? { background: "var(--rc-error-bg)", color: "var(--rc-error)" } : undefined}>
          {inStock ? t.inStock : t.outOfStock}
        </span>
      </p>

      {/* Price block: effective price is the loudest element (P1 / AC-6) */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tabular" style={{ font: "var(--rc-text-price)", color: "var(--rc-ink)" }}>
          {price != null ? (
            <CountUpPrice priceLabel={priceLabel} price={price} currency={currency ?? "KWD"} />
          ) : (
            <bdi>{priceLabel}</bdi>
          )}
        </span>
        {compareAtLabel && (
          <span
            className="tabular"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", textDecoration: "line-through" }}
          >
            <bdi>{compareAtLabel}</bdi>
          </span>
        )}
        {isBest && savings && <span className="savings-pill"><bdi>{`${t.saveLead} ${savings}`}</bdi></span>}
      </div>
      {coupon ? (
        <CouponLine row={{ coupon, merchant, effectiveLabel: effectivePriceLabel ?? null }} locale={locale} />
      ) : effectivePriceLabel ? (
        <p className="tabular mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-savings)" }}>
          <>{`${t.effectiveLead} ${effectivePriceLabel} ${t.effectiveTail}`}</>
        </p>
      ) : null}

      {isBest && (
        <p className="mt-2">
          <span className="best-flag">{t.bestPrice}</span>
        </p>
      )}

      {/* Provenance chip (§5.5): dot + time + retailer + live|cache label. */}
      <FreshnessChip
        collectedAt={collectedAt}
        method={method}
        merchant={merchant}
        locale={locale}
        renderStartMs={renderStartMs}
      />

      <TrackedOutboundLink
        href={href}
        query=""
        rank={0}
        itemId={merchant}
        className={`${isBest ? "r2-btn" : "btn-outline focusable"} mt-3 min-h-11 w-full px-4 py-2`}
      >
        {/* REEA-930 scope 1 — freshness-anchored CTA: the collection age comes
            from THIS offer's own collectedAt hop stamp and re-ticks on the
            client without a refetch; a missing/invalid stamp falls back to
            the plain "View at {merchant}" label (AC1).
            REEA-283/REEA-1091 — the first paint derives its age from the
            page's baked renderStartMs (never Date.now() during render), so the
            streamed card and its hydration pass render the same second. */}
        <OfferCtaLabel
          merchant={merchant}
          collectedAt={collectedAt}
          initialSeconds={ageSeconds(collectedAt, renderStartMs)}
          locale={locale}
          fallback={
            <>
              {t.viewAtLead} {merchant}
            </>
          }
        />
      </TrackedOutboundLink>
    </article>
  );
}
