import type { Coupon, NormalizedProduct, PriceOffer } from "@/types/product";
import { effectivePrice, formatPrice, sortOffers } from "@/lib/format";
import CouponBadge from "@/components/CouponBadge";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { resolveOfferUrl } from "@/lib/links";
import FreshnessBadge from "@/components/FreshnessBadge";

/**
 * Reemco Theme v1 §3.3 result card / §3.4 product-detail anatomy.
 * All values come from the design tokens in globals.css — no hex literals.
 * variant="card": results list. variant="detail": product page (28px price hero).
 */

const STOCK_LABEL = { in: "In stock", out: "Out of stock" } as const;

function StockDot({ state }: { state: keyof typeof STOCK_LABEL }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ font: "var(--text-body)" }}>
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{
          background: state === "in" ? "var(--color-deal)" : "var(--color-error)",
        }}
        aria-hidden
      />
      <span style={{ color: "var(--color-ink-secondary)" }}>{STOCK_LABEL[state]}</span>
    </span>
  );
}

function RetailerChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="label-token inline-flex items-center rounded px-2 py-0.5"
      style={{
        color: "var(--color-ink-secondary)",
        background: "var(--color-surface-muted)",
        border: "1px solid var(--color-border)",
      }}
    >
      {children}
    </span>
  );
}

function PriceBlock({
  offer,
  isBest,
  detail,
  coupon,
  oos = false,
}: {
  offer: PriceOffer;
  isBest: boolean;
  detail: boolean;
  coupon?: Coupon;
  oos?: boolean;
}) {
  const eff = effectivePrice(offer, coupon);
  // REEA-75: ml-auto keeps the price right-aligned when the row wraps;
  // flex-wrap on the baseline row stops the Best badge clipping (M3).
  return (
    <div className="ml-auto shrink-0 text-right">
      <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
        <span
          className="tabular"
          style={{
            font: detail ? "var(--text-display)" : "var(--text-price)",
            color: isBest ? "var(--color-deal)" : "var(--color-ink)",
            textDecoration: oos ? "line-through" : undefined,
          }}
        >
          {formatPrice(offer.price, offer.currency)}
        </span>
        {isBest && (
          <span
            className="label-token rounded px-2 py-0.5"
            style={{ background: "var(--color-deal-bg)", color: "var(--color-deal)" }}
          >
            Best
          </span>
        )}
      </div>
      {offer.wasPrice != null && offer.wasPrice > offer.price && (
        <div className="mt-1 flex items-baseline justify-end gap-1">
          {/* ▼ marks a real price drop (§3.3) */}
          <span aria-hidden style={{ color: "var(--color-warn)", fontSize: "12px" }}>
            ▼
          </span>
          <span
            className="tabular"
            style={{
              font: "var(--text-body)",
              color: "var(--color-ink-secondary)",
              textDecoration: "line-through",
            }}
          >
            {formatPrice(offer.wasPrice, offer.currency)}
          </span>
        </div>
      )}
      {/* Effective-price line: computed value, always explained (§3.3) */}
      {eff != null && (
        <p className="mt-1" style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)" }}>
          Effective{" "}
          <span className="tabular" style={{ color: "var(--color-deal)" }}>
            {formatPrice(eff, offer.currency)}
          </span>{" "}
          · incl. coupon {coupon?.code ?? coupon?.discount}
        </p>
      )}
    </div>
  );
}

export default function ProductResultCard({
  product,
  isBest = false,
  variant = "card",
  query = "",
  rank = -1,
}: {
  product: NormalizedProduct;
  /** True when this offer carries the best effective price on the page (§3.3 Von Restorff). */
  isBest?: boolean;
  variant?: "card" | "detail";
  /** REEA-37 funnel context for item_clicked events (-1 = product detail page). */
  query?: string;
  rank?: number;
}) {
  const detail = variant === "detail";
  const offers = sortOffers(product.offers);
  const best = offers[0];
  const oos = best != null && !best.inStock;
  const primaryCoupon = product.coupons[0];
  const extraCoupons = product.coupons.length - 1;

  return (
    <article className={`result-card${oos ? " is-oos" : ""}`}>
      {/* REEA-65 §4.1: honest last-verified freshness, always visible */}
      <div className="flex flex-wrap items-center gap-2">
        <RetailerChip>{product.brand}</RetailerChip>
        {best && <StockDot state={best.inStock ? "in" : "out"} />}
        <FreshnessBadge scrapedAt={product.scrapedAt} />
      </div>

      {/* REEA-75 (M4): flex-wrap lets the price drop under a long title on
          narrow viewports instead of squeezing the title to one word/line. */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {/* Title links to the product page; underline on hover only (§3.3) */}
        <h2 className="min-w-0" style={{ font: "var(--text-title)", color: "var(--color-ink)" }}>
          {detail ? (
            product.title
          ) : (
            <a
              href={`/product/${encodeURIComponent(product.productId)}`}
              className="hover:underline"
            >
              {product.title}
            </a>
          )}
        </h2>
        {best && (
          <PriceBlock
            offer={best}
            isBest={isBest && !oos}
            detail={detail}
            coupon={primaryCoupon}
            oos={oos}
          />
        )}
      </div>

      {/* Coupon badge: dashed deal border, mono code, 32px copy hit area */}
      {primaryCoupon && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CouponBadge coupon={primaryCoupon} />
          {extraCoupons > 0 && (
            <span
              title={product.coupons
                .slice(1)
                .map((c) => c.code)
                .filter(Boolean)
                .join(", ")}
              style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)" }}
            >
              +{extraCoupons} more
            </span>
          )}
        </div>
      )}

      {/* REEA-65 §4.2: the card stays cheap — retailer count + lowest price
          only; the full per-retailer comparison lives on the detail view. */}
      {!detail && best && (
        <p className="mt-3" style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
          <span className="tabular">{offers.length}</span>{" "}
          {offers.length === 1 ? "retailer" : "retailers"} · from{" "}
          <span className="tabular" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
            {formatPrice(best.price, best.currency)}
          </span>
        </p>
      )}

      {/* Offers (detail only): one row per retailer — listed price as scraped
          (REEA-60 §7.1, never adjusted), availability, direct outbound link
          resolved via resolveOfferUrl (REEA-25) with REEA-60 §4 tagging where
          enrolled (no programs live yet → untagged canonical, fail-open).
          One rule for all retailers, labeled with its assumption (§7.2). */}
      {detail && offers.length > 0 && (
        <section aria-label="Prices and availability by retailer" className="mt-4">
          <h3 className="label-token mb-1" style={{ color: "var(--color-ink-secondary)" }}>
            Prices at retailers · excl. delivery
          </h3>
          <ul>
            {offers.map((o, i) => {
              const href = resolveOfferUrl(o, product.title);
              // Neutrally labeled cheapest available offer — catalog price
              // only, no commission input (REEA-60 §7.1/§7.4).
              const isLowest = i === 0 && o.inStock;
              return (
                <li
                  key={`${o.merchant}-${o.url}`}
                  className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1"
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <span className="flex items-center gap-2">
                    <span style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
                      {o.merchant}
                    </span>
                    {isLowest && (
                      <span
                        className="label-token rounded px-2 py-0.5"
                        style={{ background: "var(--color-deal-bg)", color: "var(--color-deal)" }}
                      >
                        Lowest listed price
                      </span>
                    )}
                  </span>
                  {/* REEA-75 (M2): flex-wrap keeps the Go-to-store CTA inside
                      the card at 375px instead of overflowing the viewport. */}
                  <span className="ml-auto flex flex-wrap items-center gap-3">
                    <StockDot state={o.inStock ? "in" : "out"} />
                    <span
                      className="tabular"
                      style={{ font: "var(--text-body)", fontWeight: 600, color: "var(--color-ink)" }}
                    >
                      {formatPrice(o.price, o.currency)}
                    </span>
                    {/* REEA-13: render scraped hrefs only through validation;
                        REEA-25: stale scraped URLs fall back to a working
                        merchant search URL (resolveOfferUrl), or hide the link. */}
                    {o.inStock && href ? (
                      <TrackedOutboundLink
                        href={href}
                        query={query}
                        rank={rank}
                        itemId={product.productId}
                        className="btn-primary focusable h-10 px-4"
                      >
                        Go to store
                      </TrackedOutboundLink>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* §3.4 variations: 32px chips, selected = 2px primary border */}
      {detail && product.variations.length > 0 && (
        <section aria-label="Variations" className="mt-4">
          <h3 className="label-token mb-2" style={{ color: "var(--color-ink-secondary)" }}>
            Variations
          </h3>
          <ul className="flex flex-wrap gap-2">
            {product.variations.map((v, i) => (
              <li
                key={v.id}
                className="flex h-8 min-w-8 items-center justify-center rounded border px-2"
                style={{
                  font: "var(--text-body)",
                  fontWeight: 500,
                  borderWidth: i === 0 ? 2 : 1,
                  borderColor: i === 0 ? "var(--color-primary)" : "var(--color-border)",
                  color: i === 0 ? "var(--color-primary)" : "var(--color-ink-secondary)",
                }}
              >
                {v.label}
                {v.priceDelta !== 0 && (
                  <span className="tabular ml-1">
                    {v.priceDelta > 0 ? "+" : "−"}
                    {Math.abs(v.priceDelta).toFixed(2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* §3.4 alternatives: 48px rows, right-aligned tabular price, hairline separators */}
      {detail && product.alternatives.length > 0 && (
        <section aria-label="Alternatives" className="mt-4">
          <h3 className="label-token mb-2" style={{ color: "var(--color-ink-secondary)" }}>
            Alternatives
          </h3>
          <ul>
            {/* REEA-75: wrap + min-h so long alt titles never push the
                price past the card edge; price never shrinks. */}
            {product.alternatives.map((a) => (
              <li
                key={a.productId}
                className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded px-1 py-1 hover:bg-[var(--color-surface-muted)]"
              >
                <a
                  href={`/results?q=${encodeURIComponent(a.title)}`}
                  className="min-w-0 hover:underline"
                  style={{ font: "var(--text-body)", fontWeight: 500, color: "var(--color-ink)" }}
                >
                  {a.title}
                </a>
                <span
                  className="tabular ml-auto shrink-0"
                  style={{ font: "var(--text-body)", fontWeight: 600, color: "var(--color-ink)" }}
                >
                  from {formatPrice(a.fromPrice, best?.currency ?? "USD")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
