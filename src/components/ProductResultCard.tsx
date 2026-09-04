import type { NormalizedProduct, PriceOffer } from "@/types/product";
import { formatExpiry, formatPrice, sortOffers } from "@/lib/format";
import CouponBadge from "@/components/CouponBadge";

function AvailabilityDot({ offer }: { offer: PriceOffer }) {
  if (offer.inStock) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm"
        style={{ color: "var(--brand-slate-600)" }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--brand-green)" }}
          aria-hidden
        />
        In stock
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-sm"
      style={{ background: "var(--brand-amber-tint)", color: "var(--brand-amber)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: "var(--brand-red)" }}
        aria-hidden
      />
      Out of stock
    </span>
  );
}

export default function ProductResultCard({
  product,
}: {
  product: NormalizedProduct;
}) {
  const offers = sortOffers(product.offers);
  const best = offers[0];
  const primaryCoupon = product.coupons[0];
  const extraCoupons = product.coupons.length - 1;

  return (
    <article className="result-card">
      {/* F4: availability on the metadata line under the title, space-1 below */}
      <header className="mb-4">
        <h2 className="text-[16px] font-semibold" style={{ color: "var(--brand-ink)" }}>
          {product.title}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <span style={{ color: "var(--brand-slate-600)" }}>by {product.brand}</span>
          {best && <AvailabilityDot offer={best} />}
        </div>
      </header>

      {/* F2: price cluster — current, was, savings pill on one 28px row */}
      {best && (
        <div className="mb-4 flex items-baseline gap-2">
          <span className="price-lg">{formatPrice(best.price, best.currency)}</span>
          {best.wasPrice != null && best.wasPrice > best.price && (
            <>
              <span className="price-strike">
                {formatPrice(best.wasPrice, best.currency)}
              </span>
              <span
                className="rounded px-2 py-1 text-[12px] font-medium leading-4"
                style={{ background: "var(--brand-green-tint)", color: "var(--brand-green)" }}
              >
                Save {formatPrice(best.wasPrice - best.price, best.currency)}
              </span>
            </>
          )}
        </div>
      )}

      {/* F3: one coupon badge per card, extras collapsed */}
      {primaryCoupon && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <CouponBadge coupon={primaryCoupon} />
          {extraCoupons > 0 && (
            <a
              href="#coupons"
              className="text-[13px] underline underline-offset-2"
              style={{ color: "var(--brand-blue)" }}
            >
              +{extraCoupons} more
            </a>
          )}
          {formatExpiry(primaryCoupon.expiresAt) && (
            <span className="text-[13px]" style={{ color: "var(--brand-slate-600)" }}>
              expires {formatExpiry(primaryCoupon.expiresAt)}
            </span>
          )}
        </div>
      )}

      {/* All offers: price + availability per merchant */}
      <section aria-label="Prices and availability" className="mb-4">
        <h3 className="label-token mb-1" style={{ color: "var(--brand-slate-400)" }}>
          All offers
        </h3>
        {offers.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--brand-slate-600)" }}>
            No offers available.
          </p>
        ) : (
          <ul>
            {offers.map((o) => (
              <li
                key={`${o.merchant}-${o.url}`}
                className="flex h-12 items-center justify-between gap-2"
                style={{ borderTop: "1px solid var(--brand-border)" }}
              >
                <span className="text-sm" style={{ color: "var(--brand-slate-600)" }}>
                  {o.merchant}
                </span>
                <span className="flex items-center gap-3">
                  <AvailabilityDot offer={o} />
                  <span
                    className="text-sm font-semibold tabular-nums"
                    style={{ color: "var(--brand-ink)" }}
                  >
                    {formatPrice(o.price, o.currency)}
                  </span>
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-8 items-center rounded px-2 text-[13px] underline underline-offset-2"
                    style={{ color: "var(--brand-blue)" }}
                  >
                    Visit
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* F5: variations chips, 32px hit targets, blue selected accent */}
      <section aria-label="Variations" className="mb-4">
        <h3 className="label-token mb-2" style={{ color: "var(--brand-slate-400)" }}>
          Variations
        </h3>
        {product.variations.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--brand-slate-600)" }}>No variations.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {product.variations.map((v, i) => (
              <li
                key={v.id}
                className="flex h-8 min-w-8 items-center justify-center rounded border px-2 text-sm font-medium"
                style={
                  i === 0
                    ? { borderWidth: 2, borderColor: "var(--brand-blue)", color: "var(--brand-blue)" }
                    : { borderColor: "var(--brand-border)", color: "var(--brand-slate-600)" }
                }
              >
                {v.label}
                {v.priceDelta !== 0 && (
                  <span className="ml-1">
                    {v.priceDelta > 0 ? "+" : "−"}
                    {Math.abs(v.priceDelta).toFixed(2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* F6: alternatives as 48px rows with separators, no nested cards */}
      <section aria-label="Alternatives">
        <h3 className="label-token mb-2" style={{ color: "var(--brand-slate-400)" }}>
          Alternatives
        </h3>
        {product.alternatives.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--brand-slate-600)" }}>No alternatives.</p>
        ) : (
          <ul>
            {product.alternatives.map((a) => (
              <li
                key={a.productId}
                className="flex h-12 items-center justify-between gap-2 rounded px-1 hover:bg-[#F7F8FA]"
              >
                <a
                  href={`/results?q=${encodeURIComponent(a.title)}`}
                  className="text-sm font-medium underline-offset-2 hover:underline"
                  style={{ color: "var(--brand-ink)" }}
                >
                  {a.title}
                </a>
                <span
                  className="text-sm font-semibold tabular-nums"
                  style={{ color: "var(--brand-ink)" }}
                >
                  from {formatPrice(a.fromPrice, best?.currency ?? "USD")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
