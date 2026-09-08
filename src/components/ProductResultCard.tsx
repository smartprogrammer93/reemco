import Link from "next/link";
import type { Coupon, NormalizedProduct, PriceOffer } from "@/types/product";
import { buildResultsHref, type CountryCode } from "@/lib/country";
import { effectivePrice, formatPrimaryPrice, sortOffers } from "@/lib/format";
import { gradeBadgeLabel } from "@/lib/collect/canonical-product";
import CouponBadge from "@/components/CouponBadge";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { resolveOfferUrl } from "@/lib/links";
import FreshnessBadge from "@/components/FreshnessBadge";

/**
 * Reemco Design v3 result card (§5.2–§5.4). Single token namespace from
 * globals.css — no hex literals. variant="card": results list.
 * variant="detail" (REEA-101 realtime AC-1): ships IDENTITIES ONLY in the
 * served HTML — brand chip, title, coupon pill, variations, alternatives.
 * Offer prices/availability render solely from the live collection job
 * (CollectionPanel below), so one screen never shows two contradicting
 * freshness passes. variant="card" keeps the full normalized-feed summary:
 * the results list has no live job and is the feed's serving surface.
 */

const STOCK_LABEL = { in: "In stock", out: "Out of stock" } as const;

function StockDot({ state }: { state: keyof typeof STOCK_LABEL }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ font: "var(--rc-text-body)" }}>
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{
          background: state === "in" ? "var(--rc-savings)" : "var(--rc-error)",
        }}
        aria-hidden
      />
      <span style={{ color: "var(--rc-body-text)" }}>{STOCK_LABEL[state]}</span>
    </span>
  );
}

function RetailerChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="label-token inline-flex items-center rounded px-2 py-0.5"
      style={{
        color: "var(--rc-body-text)",
        background: "var(--rc-canvas)",
        border: "1px solid var(--rc-line)",
      }}
    >
      {children}
    </span>
  );
}

function PriceBlock({
  offer,
  isBest,
  coupon,
  oos = false,
}: {
  offer: PriceOffer;
  isBest: boolean;
  coupon?: Coupon;
  oos?: boolean;
}) {
  const eff = effectivePrice(offer, coupon);
  // REEA-75: ml-auto keeps the price right-aligned when the row wraps;
  // flex-wrap on the baseline row stops the Best badge clipping (M3).
  const saved = offer.wasPrice != null && offer.wasPrice > offer.price;
  // REEA-195 AC-4: KWD is the primary currency on every offer card; SAR-only
  // (and other scraped) figures convert through the reference factor with the
  // scraped stamp kept beside them.
  const hero = formatPrimaryPrice(offer.price, offer.currency);
  return (
    // REEA-95 step-5 mobile pass: at narrow widths the price block takes the
    // full row so its chips wrap inside the viewport instead of forcing the
    // card wider than the screen (sm: restores side-by-side with the title).
    <div className="ml-auto w-full shrink-0 text-right sm:w-auto">
      <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
        <span
          className="tabular"
          style={{
            font: "var(--rc-text-price)",
            color: isBest ? "var(--rc-savings)" : "var(--rc-ink)",
            textDecoration: oos ? "line-through" : undefined,
          }}
        >
          {hero.label}
        </span>
        {/* §5.3: strikethrough compare-at BESIDE the price, savings pill right
            after it — savings emphasis without stealing the price's crown. */}
        {saved && offer.wasPrice != null && (
          <span
            className="tabular"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", textDecoration: "line-through" }}
          >
            {formatPrimaryPrice(offer.wasPrice, offer.currency).label}
          </span>
        )}
        {saved && offer.wasPrice != null && (
          <span className="savings-pill">Save {formatPrimaryPrice(offer.wasPrice - offer.price, offer.currency).label}</span>
        )}
        {isBest && <span className="best-flag">Best price</span>}
      </div>
      {/* Effective-price line: computed value, always explained (§3.3) */}
      {eff != null && (
        <p className="mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}>
          Effective{" "}
          <span className="tabular" style={{ color: "var(--rc-savings)" }}>
            {formatPrimaryPrice(eff, offer.currency).label}
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
  country = null,
  showOutOfStock = false,
}: {
  product: NormalizedProduct;
  /** True when this offer carries the best effective price on the page (§3.3 Von Restorff). */
  isBest?: boolean;
  variant?: "card" | "detail";
  /** REEA-37 funnel context for item_clicked events (-1 = product detail page). */
  query?: string;
  rank?: number;
  /** REEA-170 active country selection, carried into alternatives queries. */
  country?: CountryCode | null;
  /** REEA-186 stock selection, carried into alternatives queries on the list. */
  showOutOfStock?: boolean;
}) {
  const detail = variant === "detail";
  const offers = sortOffers(product.offers);
  const best = offers[0];
  // Base figure for the swatch chips (REEA-254): the cheapest listed price on
  // the card — the same base the server used for each swatch's priceDelta.
  const cheapestListed = offers.length > 0 ? Math.min(...offers.map((o) => o.price)) : 0;
  const oos = best != null && !best.inStock;
  const primaryCoupon = product.coupons[0];
  const extraCoupons = product.coupons.length - 1;

  return (
    <article className={`result-card${oos ? " is-oos" : ""}`}>
      {/* REEA-65 §4.1: honest last-verified freshness, always visible on the
          feed-served results list (the detail view's freshness comes from the
          live job instead — realtime AC-1). */}
      <div className="flex flex-wrap items-center gap-2">
        {/* REEA-189 Rule 1 step 3: an unresolved brand renders NO brand line —
            an empty chip is itself an artifact. */}
        {product.brand ? <RetailerChip>{product.brand}</RetailerChip> : null}
        {!detail && best && <StockDot state={best.inStock ? "in" : "out"} />}
        {!detail && <FreshnessBadge scrapedAt={product.scrapedAt} />}
      </div>

      {/* REEA-75 (M4): flex-wrap lets the price drop under a long title on
          narrow viewports instead of squeezing the title to one word/line. */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {/* Title links to the product page; underline on hover only (§3.3) */}
        <h2 className="min-w-0" style={{ font: "var(--rc-text-title)", color: "var(--rc-ink)" }}>
          {detail ? (
            product.title
          ) : (
            <Link
              href={`/product/${encodeURIComponent(product.productId)}`}
              className="hover:underline"
            >
              {product.title}
            </Link>
          )}
        </h2>
        {/* Chrome-only detail (realtime AC-1): the price header renders on the
            feed-served results list; the product page's price comes solely
            from the live collection below. */}
        {!detail && best && (
          <PriceBlock
            offer={best}
            isBest={isBest && !oos}
            coupon={primaryCoupon}
            oos={oos}
          />
        )}
      </div>

      {/* Coupon pill (§5.4): amber, value only; extras count beside it */}
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
              style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}
            >
              +{extraCoupons} more
            </span>
          )}
        </div>
      )}

      {/* REEA-65 §4.2: the card stays cheap — retailer count + lowest price
          only; the full per-retailer comparison lives on the detail view. */}
      {!detail && best && (
        <p className="mt-3" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          <span className="tabular">{offers.length}</span>{" "}
          {offers.length === 1 ? "retailer" : "retailers"} · from{" "}
          <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
            {formatPrimaryPrice(best.price, best.currency).label}
          </span>
        </p>
      )}

      {/* REEA-254: colour swatches inside one model+storage card — each chip
          carries that colour's best listed price (effective = listed here:
          live offers carry no coupon), computed off the same cheapest-row
          figure the server used for `priceDelta`. Rendered only when the
          merged card actually spans more than one colour; a single-colour
          card keeps the plain price treatment above. */}
      {!detail && best && product.variations.length > 0 && (
        <section
          aria-label="Colour options"
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          {product.variations.map((v) => (
            <span
              key={v.id}
              className="label-token inline-flex items-center gap-1 rounded px-2 py-0.5"
              style={{
                color: "var(--rc-body-text)",
                background: "var(--rc-canvas)",
                border: "1px solid var(--rc-line)",
              }}
            >
              {v.label}
              <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                {formatPrimaryPrice(cheapestListed + v.priceDelta, best.currency).label}
              </span>
            </span>
          ))}
        </section>
      )}

      {/* Offers: one row per retailer — listed price as scraped
          (REEA-60 §7.1, never adjusted), availability, direct outbound link
          resolved via resolveOfferUrl (REEA-25) with REEA-60 §4 tagging where
          enrolled (no programs live yet → untagged canonical, fail-open).
          One rule for all retailers, labeled with its assumption (§7.2).
          REEA-101 realtime AC-1: the results LIST is the feed's serving
          surface; on the product page these rows render solely from the live
          collection job (CollectionPanel) so seeded figures and live figures
          never sit on one screen contradicting each other. */}
      {!detail && offers.length > 0 && (
        <section aria-label="Prices and availability by retailer" className="mt-4">
          <h3 className="label-token mb-1" style={{ color: "var(--rc-body-text)" }}>
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
                  /* REEA-203: ONE row structure per breakpoint — below sm every
                     row stacks its label line above the right-aligned action
                     cluster; from sm up every row renders inline with no row-level
                     reflow (no sm:wrap — a chip on the label column must not push
                     the action cluster onto its own line like a wrap would). The
                     label column absorbs its own wraps; the action cluster keeps
                     its intrinsic width so every row shares one baseline. */
                  className="flex flex-col justify-between gap-1 py-1 sm:flex-row sm:items-center sm:gap-x-2"
                  style={{ borderTop: "1px solid var(--rc-line)" }}
                >
                  {/* REEA-224 item 1 (measured on the deployed shell): the
                      merchant name and its chips are ONE inline unit. With
                      flex-wrap the column stacked the ~156px chip under the
                      name at 1280 (row grew 53 -> ~62px), breaking the
                      equal-height rhythm. Name + one-line chips (each
                      whitespace-nowrap) ride inline; the design-pass 160px
                      floor keeps the column at least chip-wide; chips shrink
                      as whole units, never half-wrap their own text. */}
                  <span className="flex min-w-[160px] items-center gap-2">
                    <span style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
                      {o.merchant}
                    </span>
                    {/* REEA-167 §2: condition grade rides its own row badge —
                        renewed/refurbished offers stay distinguishable, never
                        blended into the new-condition price list. */}
                    {o.grade && gradeBadgeLabel(o.grade) ? (
                      <span
                        className="label-token whitespace-nowrap rounded px-2 py-0.5"
                        style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
                      >
                        {gradeBadgeLabel(o.grade)}
                      </span>
                    ) : null}
                    {isLowest && (
                      <span
                        className="label-token whitespace-nowrap rounded px-2 py-0.5"
                        style={{ background: "var(--rc-savings-bg)", color: "var(--rc-savings)" }}
                      >
                        Lowest listed price
                      </span>
                    )}
                  </span>
                  {/* REEA-224 item 3 (measured on the deployed shell): the
                      cluster stays a single nowrap flex line — with flex-wrap
                      the dot+price block stacked on its own line ABOVE the
                      button at ~480 (cluster grew to ~80px), so the button
                      sat bottom-aligned instead of centered against the
                      wrapped price block. Without wrap the combined
                      KWD-stamp span (min-w-0) wraps within its own box while
                      the shrink-0 button (min-h-11) stays pinned at the row's
                      right edge; items-center centers it against the wrapped
                      price block. Overflow at narrow widths is absorbed by
                      the min-w-0 price span, keeping the CTA inside the card
                      (REEA-75 M2 intent). */}
                  <span className="ml-auto flex min-w-0 items-center justify-end gap-3 sm:shrink-0">
                    <StockDot state={o.inStock ? "in" : "out"} />
                    <span
                      className="tabular min-w-0"
                      style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                    >
                      {formatPrimaryPrice(o.price, o.currency).label}
                    </span>
                    {/* REEA-13: render scraped hrefs only through validation;
                        REEA-116: direct retailer product URLs for every
                        adapter host; Bing search only when no URL captured
                        (resolveOfferUrl). */}
                    {o.inStock && href ? (
                      <TrackedOutboundLink
                        href={href}
                        query={query}
                        rank={rank}
                        itemId={product.productId}
                        className="btn-primary focusable min-h-11 shrink-0 px-4"
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
          <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
            Variations
          </h3>
          <ul className="flex flex-wrap gap-2">
            {product.variations.map((v, i) => (
              <li
                key={v.id}
                className="flex h-8 min-w-8 items-center justify-center rounded border px-2"
                style={{
                  font: "var(--rc-text-body)",
                  fontWeight: 500,
                  borderWidth: i === 0 ? 2 : 1,
                  borderColor: i === 0 ? "var(--rc-primary)" : "var(--rc-line)",
                  color: i === 0 ? "var(--rc-primary)" : "var(--rc-body-text)",
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
          <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
            Alternatives
          </h3>
          <ul>
            {/* REEA-75: wrap + min-h so long alt titles never push the
                price past the card edge; price never shrinks. */}
            {product.alternatives.map((a) => (
              <li
                key={a.productId}
                className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded px-1 py-1 hover:bg-[var(--rc-canvas)]"
              >
                <a
                  href={buildResultsHref(a.title, 1, country, showOutOfStock)}
                  className="min-w-0 hover:underline"
                  style={{ font: "var(--rc-text-body)", fontWeight: 500, color: "var(--rc-ink)" }}
                >
                  {a.title}
                </a>
                <span
                  className="tabular ml-auto shrink-0"
                  style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                >
                  from {formatPrimaryPrice(a.fromPrice, best?.currency ?? "USD").label}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
