import Link from "next/link";
import Image from "next/image";
import type { NormalizedProduct, PriceOffer, ProductAlternative } from "@/types/product";
import { buildResultsHref, currencyForCountry, type CountryCode } from "@/lib/country";
import { effectivePriceKwd, formatCountryPrice, formatKWD, formatPrimaryPrice, sortOffers } from "@/lib/format";
import { canonicalKey, dedupVariantKey, gradeBadgeLabel } from "@/lib/collect/canonical-product";
import { ageSeconds, collectedClock, localizedAgeFromStamp } from "@/lib/relative-time";
import CouponLine, { buildCouponRows } from "@/components/CouponLine";
import ShareSummaryButton from "@/components/ShareSummaryButton";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { LiveAge } from "@/components/OfferCtaLabel";
import { resolveOfferUrl } from "@/lib/links";
import { formatSeenRangeLabel } from "@/lib/seen-range";
import { cleanDisplayTitle, displayTitleChanged } from "@/lib/display-title";
import { isProxiedImageSrc, proxiedImageSrc } from "@/lib/image-proxy";
import ProxyRetryImage from "@/components/ProxyRetryImage";
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";
import FreshnessBadge from "@/components/FreshnessBadge";
import OfferStatusToken from "@/components/OfferStatus";
import { offerStatusForOffer } from "@/lib/offer-status";

/**
 * REEA-963 R1 FR-1 — the query-time sanity verdict helpers. A flagged offer
 * stays visible but never reads as trustworthy: it renders the warning
 * affordance and is excluded from every rollup, cheapest highlight and
 * best-price claim on this card (FR-1.4). Ranking order is untouched
 * (spec non-goal: sanity flags change presentation, not ranking).
 */
function offerFlagged(o: PriceOffer): boolean {
  return o.sanity?.status === "flagged";
}

/**
 * REEA-1096 D6 — the accepted shelf card anatomy caps the visible offer rows
 * at three (the pack's card height target assumes a bounded row set; the PM
 * brief for this ticket fixes the cap at 3). The rest stay reachable through
 * the product page's full offers table via the "view all N offers" link.
 */
const MAX_SHELF_OFFERS = 3;

/** The native title-attribute sentence for a flagged offer's reason. */
function verifyTitleFor(reason: string | undefined, t: ReturnType<typeof getStrings>): string {
  switch (reason) {
    case "outlier_high":
    case "outlier_low":
      return t.verifyOutlier;
    case "currency_mis_map":
      return t.verifyCurrency;
    case "price_unavailable":
      return t.verifyNoPrice;
    default:
      return t.priceVerifyBadge;
  }
}

/**
 * Reemco Design v5 — Direction A "Shelf" result card (REEA-1055 §3,
 * REEA-1069). Retail-shelf grammar: price first, real product imagery at
 * recognition scale, fixed two-line offer anatomy, ONE neutral status token
 * per offer, savings always naming its baseline. No hex literals — every
 * colour is a --rc-* token from globals.css.
 *
 * variant="card": results-list shelf card.
 * variant="detail": identity-only hero card (the product page's live hero is
 * ProductHero; this variant remains the shared identity/accessory surface and
 * ships identities only, so one screen never shows two freshness passes).
 */

function StockDot({ state, locale }: { state: "in" | "out"; locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <span className="inline-flex items-center gap-1.5" style={{ font: "var(--rc-text-body)" }}>
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: state === "in" ? "var(--rc-savings)" : "var(--rc-error)" }}
        aria-hidden
      />
      <span style={{ color: "var(--rc-body-text)" }}>{state === "in" ? t.inStock : t.outOfStock}</span>
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

function CategoryGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} width={44} height={44} aria-hidden>
      <path d="M3 9.5 5.5 4h13L21 9.5V20H3V9.5Z" />
      <path d="M3 9.5h18M8.5 13.5h7" />
    </svg>
  );
}

/** Card media: the retailer's real product image at recognition scale. The
 *  frame reserves its geometry and shows the category glyph when no image
 *  exists — never a broken icon, never an invented placeholder product.
 *
 *  REEA-1128 — the source goes through proxiedImageSrc(): a `cdn.shopify.com`
 *  product photo is rendered as the same-origin `/api/image?u=…` URL, so the
 *  shopper's browser never eats Shopify's intermittent 403 (empty frame +
 *  console error). A proxied source renders through ProxyRetryImage, which
 *  re-requests the photo if the proxy had to answer with its miss glyph;
 *  every other retailer image keeps its direct URL, and
 *  `referrerPolicy="no-referrer"` keeps our origin off the retailer CDN's
 *  logs. */
function CardMedia({ product, locale, query, country }: { product: NormalizedProduct; locale?: Locale; query?: string; country?: CountryCode | null }) {
  const src = proxiedImageSrc(product.image ?? product.offers.find((o) => o.image)?.image);
  const displayTitle = cleanDisplayTitle(product.title);
  const alt = `${displayTitle} — ${locale === "ar" ? "صورة المنتج" : "product image"}`;
  if (!src) {
    return (
      <div className="rc-card-media">
        <span className="rc-media-glyph" aria-hidden>
          <CategoryGlyph />
        </span>
        <div className="rc-card-share">
          <ShareSummaryButton product={product} query={query} country={country} locale={locale} iconOnly />
        </div>
      </div>
    );
  }
  return (
    <div className="rc-card-media">
      {isProxiedImageSrc(src) ? (
        <ProxyRetryImage src={src} alt={alt} width={160} height={160} />
      ) : (
        <Image
          src={src}
          alt={alt}
          width={160}
          height={160}
          sizes="(max-width: 640px) 100px, 160px"
          unoptimized
          referrerPolicy="no-referrer"
        />
      )}
      <div className="rc-card-share">
        <ShareSummaryButton product={product} query={query} country={country} locale={locale} iconOnly />
      </div>
    </div>
  );
}

/** Detail-variant thumbnail pair (identity surface only). Same REEA-1128
 *  proxy policy as the shelf card, so the product page cannot show a broken
 *  Shopify thumbnail either. */
function ThumbRow({ product }: { product: NormalizedProduct }) {
  const urls: string[] = [];
  const add = (src?: string) => {
    const proxied = proxiedImageSrc(src);
    if (proxied && !urls.includes(proxied) && urls.length < 2) {
      urls.push(proxied);
    }
  };
  add(product.image);
  for (const o of product.offers) add(o.image);
  if (urls.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {urls.map((src) =>
        isProxiedImageSrc(src) ? (
          <ProxyRetryImage
            key={src}
            src={src}
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 rounded object-contain"
            style={{ background: "var(--rc-canvas)" }}
          />
        ) : (
          <Image
            key={src}
            src={src}
            alt=""
            width={64}
            height={64}
            sizes="64px"
            unoptimized
            referrerPolicy="no-referrer"
            className="h-16 w-16 rounded object-contain"
            style={{ background: "var(--rc-canvas)" }}
          />
        ),
      )}
    </div>
  );
}

/**
 * REEA-930 scope 2/3 — the lead card's primary CTA: the one outbound action
 * that completes the shopper's job, carrying the two decision signals the
 * 0.37%-CTR CTA lacked. The decision line states the best EFFECTIVE price
 * and the destination retailer ("Best effective price KD 42.90 → Xcite");
 * when the card's best coupon actually lowers this offer, the figure IS the
 * post-coupon one and the line says so verbatim (existing effectiveTail —
 * REEA-784/REEA-760 honesty rules carry over). The freshness line re-derives
 * the collection age from the offer's own `collectedAt` (OfferCtaLabel's
 * LiveAge: baked-clock first paint, live tick after hydration, no refetch).
 */
function LeadOfferCta({
  merchant,
  href,
  effectiveLabel,
  couponed,
  pending,
  collectedAt,
  initialSeconds,
  query,
  rank,
  itemId,
  queryId,
  locale,
}: {
  merchant: string;
  href: string;
  effectiveLabel: string;
  couponed: boolean;
  pending: boolean;
  collectedAt?: string;
  initialSeconds: number | null;
  query: string;
  rank: number;
  itemId: string;
  queryId?: string;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="mt-3">
      <TrackedOutboundLink
        href={href}
        query={query}
        rank={rank}
        itemId={itemId}
        queryId={queryId}
        retailer={merchant}
        className="cta-lead r2-btn focusable w-full"
      >
        <span className="cta-lead-main">
          {pending ? (
            <span role="status">{t.kuwaitChecking}</span>
          ) : (
            <>
              <span>{t.ctaBestLead}</span>
              <bdi className="tabular">{effectiveLabel}</bdi>
              {couponed && <span>{t.effectiveTail}</span>}
              <span aria-hidden>{t.ctaArrow}</span>
              <bdi>{merchant}</bdi>
            </>
          )}
        </span>
        {collectedAt != null && initialSeconds != null && (
          <span className="cta-lead-age">
            {t.ctaCheckedLead} <LiveAge collectedAt={collectedAt} initialSeconds={initialSeconds} locale={locale} />
          </span>
        )}
      </TrackedOutboundLink>
    </div>
  );
}

/**
 * REEA-787 — variant-aware retailer-row fold, applied right AFTER sortOffers
 * so it inherits the single REEA-604 ordering key and the stable live-first
 * order. One row survives per (merchant(lower) | folded variant tier | grade
 * badge | effective figure).
 */
export function foldRetailerRows(
  offers: PriceOffer[],
  coupon: { discount: string } | null,
): PriceOffer[] {
  const seen = new Set<string>();
  const rows: PriceOffer[] = [];
  for (const o of offers) {
    const effective = effectivePriceKwd(o.price, o.currency, {
      wasPrice: o.wasPrice,
      couponDiscount: coupon?.discount ?? null,
    });
    const key = [
      o.merchant.toLowerCase(),
      dedupVariantKey(o.label ?? ""),
      gradeBadgeLabel(o.grade ?? "") ?? "",
      formatKWD(effective),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(o);
  }
  return rows;
}

/**
 * REEA-1122 — the absolute price base a variant chip rides: the card's
 * cheapest listed offer after the same fold/sort the card renders, excluding
 * flagged offers (REEA-963 FR-1.4). Shared by the results card and the
 * product hero so both print the identical absolute figure. The hero used to
 * print the raw `priceDelta`, so the cheapest variant read "Orange KD 0".
 */
export function cheapestListedKwd(product: NormalizedProduct): number | null {
  const coupon = product.coupons[0] ?? null;
  const offers = foldRetailerRows(sortOffers(product.offers, coupon), coupon);
  const priced = offers.filter((o) => !offerFlagged(o));
  return priced.length > 0
    ? Math.min(
        ...priced.map((o) =>
          effectivePriceKwd(o.price, o.currency, {
            wasPrice: o.wasPrice,
            couponDiscount: coupon?.discount,
          }),
        ),
      )
    : null;
}

/**
 * REEA-787 — alternatives/pairs fold: duplicate cards for ONE matched product
 * (the REEA-167 canonicalKey title identity) with an IDENTICAL formatted
 * fromPrice collapse to the first entry.
 */
export function foldAlternativeRows(rows: ProductAlternative[]): ProductAlternative[] {
  const seen = new Set<string>();
  const out: ProductAlternative[] = [];
  for (const a of rows) {
    const key = `${canonicalKey(a.title)}|${formatPrimaryPrice(a.fromPrice, "KWD").label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Direction A offer row — two explicit lines, fixed anatomy:
 *   line A: retailer wordmark + listing qualifier/grade + stock + ONE status
 *   line B: price (largest text in the row) + checked time + action
 * The row is a single <li class="offer-row"> so the REEA-848 containment
 * contract (no collision, no overflow, CTA inside the card) still holds; the
 * design classes carry the fixed positions.
 */
function ShelfOfferRow({
  offer,
  product,
  query,
  rank,
  country,
  renderStartMs,
  locale,
  queryId,
}: {
  offer: PriceOffer;
  product: NormalizedProduct;
  query: string;
  rank: number;
  country: CountryCode | null;
  renderStartMs?: number;
  locale?: Locale;
  queryId?: string;
}) {
  const t = getStrings(locale ?? clientLocale());
  const href = resolveOfferUrl(offer, product.title);
  const row = formatCountryPrice(offer.price, offer.currency, country);
  const rowReason = offerFlagged(offer) ? offer.sanity?.reason : undefined;
  const rowUnavailable = rowReason === "price_unavailable";
  // REEA-1100 — the legacy offer-row age rides the same localized age helper
  // as the shelf CTA and ProductHero: sub-minute reads "Checked just now" /
  // "حُدِّث الآن", never a raw "0s ago"; invalid stamps keep the localized
  // unknown copy instead of inventing a moment.
  const ageLabel = localizedAgeFromStamp(locale ?? clientLocale(), offer.collectedAt, renderStartMs);
  const clock = collectedClock(offer.collectedAt);
  const checked =
    offer.fromSnapshot && clock != null
      ? `${t.collectedWord} ${clock}`
      : ageLabel != null
        ? `${t.checkedLead} ${ageLabel}`
        : t.dateUnknown;
  // eslint-disable-next-line react-hooks/purity -- fallback clock only when the server did not bake renderStartMs (REEA-283 pattern).
  const status = offerStatusForOffer(offer, renderStartMs ?? Date.now());
  return (
    <li className={`offer-row rc-offer-row${offer.inStock ? "" : " is-out"}`}>
      <div className="rc-offer-line line-a">
        <span className="rc-retailer-name">
          <bdi className="logo lat">{offer.merchant}</bdi>
        </span>
        {offer.label ? (
          <span
            dir="auto"
            className="label-token inline-flex min-w-0 max-w-[36ch] shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap rounded px-2 py-0.5"
            title={offer.label}
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
          >
            {offer.label}
          </span>
        ) : null}
        {offer.grade && gradeBadgeLabel(offer.grade) ? (
          <span
            className="label-token shrink-0 whitespace-nowrap rounded px-2 py-0.5"
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
          >
            {gradeBadgeLabel(offer.grade)}
          </span>
        ) : null}
        <span className={`rc-stock${offer.inStock ? "" : " is-out"}`}>
          <span className="dot" aria-hidden />
          {offer.inStock ? t.inStock : t.outOfStock}
        </span>
        <OfferStatusToken
          status={status}
          locale={locale}
          title={rowReason && !rowUnavailable ? verifyTitleFor(rowReason, t) : undefined}
        />
      </div>
      <div className="rc-offer-line line-b">
        {/* REEA-1094 — line B keeps the price as the largest figure and the
            action in the inline-end slot; the conversion stamp and the
            collection stamp share ONE meta sub-line under the price at 375,
            so a foreign-currency row never has to widen past the card. The
            wrappers are display:contents above 641px (globals.css), so the
            desktop line/table geometry is unchanged. */}
        <span className="rc-price-block">
          {rowUnavailable ? (
            <span className="price-cur rc-price-sm tabular" style={{ color: "var(--rc-muted)" }}>
              <bdi>{t.priceUnavailable}</bdi>
            </span>
          ) : (
            <span
              className="price-cur rc-price-sm tabular"
              style={{ fontWeight: 600, color: "var(--rc-ink)" }}
            >
              <bdi>{row.primary}</bdi>
            </span>
          )}
          <span className="rc-price-meta">
            {!rowUnavailable && row.alt && (
              <span className="price-alt">
                <span className="price-alt-sep" aria-hidden>
                  ·{" "}
                </span>
                <bdi>{row.alt}</bdi>
              </span>
            )}
            <span className="rc-checked">{checked}</span>
          </span>
        </span>
        {!offer.inStock || !href ? (
          <button type="button" className="btn-secondary rc-offer-cta" disabled>
            {t.offerGo}
          </button>
        ) : (
          <TrackedOutboundLink
            href={href}
            query={query}
            rank={rank}
            itemId={product.productId}
            queryId={queryId}
            retailer={offer.merchant}
            className="btn-primary focusable min-h-9 shrink-0 px-3 rc-offer-cta"
          >
            {t.offerGo}
          </TrackedOutboundLink>
        )}
      </div>
    </li>
  );
}

export default function ProductResultCard({
  product,
  isBest = false,
  kuwaitBatchPending = false,
  kuwaitPendingStatus = false,
  variant = "card",
  query = "",
  rank = -1,
  country = null,
  showOutOfStock = false,
  renderStartMs,
  locale,
  cascadeIndex,
  queryId,
}: {
  product: NormalizedProduct;
  isBest?: boolean;
  kuwaitBatchPending?: boolean;
  kuwaitPendingStatus?: boolean;
  variant?: "card" | "detail";
  query?: string;
  rank?: number;
  queryId?: string;
  country?: CountryCode | null;
  showOutOfStock?: boolean;
  renderStartMs?: number;
  locale?: Locale;
  cascadeIndex?: number;
}) {
  const detail = variant === "detail";
  const t = getStrings(locale ?? clientLocale());
  const displayTitle = cleanDisplayTitle(product.title);
  const titleChanged = displayTitleChanged(product.title, displayTitle);
  const primaryCoupon = product.coupons[0];
  const offers = foldRetailerRows(
    sortOffers(product.offers, primaryCoupon ?? null),
    primaryCoupon ?? null,
  );
  const best = offers[0];
  const kuwaitChecking =
    kuwaitBatchPending &&
    (kuwaitPendingStatus ||
      (best != null &&
        (country ? currencyForCountry(country) : best.currency).trim().toUpperCase() !== "KWD"));
  // REEA-1122 — one absolute-price base, shared with the product hero, so a
  // variant chip never prints a bare delta ("KD 0").
  const cheapestListed = cheapestListedKwd(product);
  const oos = best != null && !best.inStock;
  const couponRows = buildCouponRows(product.coupons, offers, country);
  // REEA-1096 D6 — the disclosure only renders when there is something behind
  // it (a card with zero offers and no extras must not show an empty drawer).
  const altRows = foldAlternativeRows(product.alternatives);
  const pairRows = foldAlternativeRows(product.pairsWith ?? []);
  const hasMore =
    couponRows.length > 0 ||
    (!primaryCoupon && offers.length > 0) ||
    best != null ||
    product.seenRange != null ||
    altRows.length > 0 ||
    pairRows.length > 0;

  const bestHref = best != null ? resolveOfferUrl(best, product.title) : null;
  const showLeadCta =
    !detail && isBest && best != null && best.inStock && !!bestHref && !offerFlagged(best);
  const leadEff =
    best != null
      ? effectivePriceKwd(best.price, best.currency, {
          wasPrice: best.wasPrice,
          couponDiscount: primaryCoupon?.discount ?? null,
        })
      : null;
  const leadEffPlain =
    best != null ? effectivePriceKwd(best.price, best.currency, { wasPrice: best.wasPrice }) : null;
  const leadCompareAtCouponed =
    primaryCoupon != null && best != null && best.wasPrice != null && best.wasPrice > best.price;
  const leadCouponed =
    (primaryCoupon != null && leadEff != null && leadEffPlain != null && leadEff < leadEffPlain) ||
    leadCompareAtCouponed;
  const leadEffLabel =
    leadEff != null
      ? formatCountryPrice(leadEff, "KWD", country).primary.replace(/\u00A0/g, " ")
      : null;
  const leadAgeSecs = best != null ? ageSeconds(best.collectedAt, renderStartMs) : null;

  const heroReason = best && offerFlagged(best) ? best.sanity?.reason : undefined;
  const heroUnavailable = heroReason === "price_unavailable";
  const heroPrice = best ? formatCountryPrice(best.price, best.currency, country) : null;
  const saved =
    best != null && !heroUnavailable && best.wasPrice != null && best.wasPrice > best.price;
  const heroSavedAmount =
    best != null && best.wasPrice != null && best.wasPrice > best.price
      ? formatCountryPrice(best.wasPrice - best.price, best.currency, country).primary
      : null;

  if (detail) {
    return (
      <article className={`result-card${oos ? " is-oos" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          {product.brand ? <RetailerChip>{product.brand}</RetailerChip> : null}
          {best && <StockDot state={best.inStock ? "in" : "out"} locale={locale} />}
          <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />
          <ShareSummaryButton product={product} query={query} country={country} locale={locale} />
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 items-start gap-2">
            <ThumbRow product={product} />
            <h2
              className="min-w-0"
              style={{ font: "var(--rc-text-title)", color: "var(--rc-ink)" }}
              title={titleChanged ? product.title : undefined}
            >
              {displayTitle}
            </h2>
          </div>
        </div>
        {titleChanged && (
          <details className="rc-card-title-disclosure mt-1">
            <summary
              className="label-token cursor-pointer list-none inline-flex items-center rounded px-2 py-0.5"
              style={{ color: "var(--rc-muted)", border: "1px solid var(--rc-line)" }}
            >
              {t.originalTitleLabel}
            </summary>
            <p className="mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
              {product.title}
            </p>
          </details>
        )}
        {product.variations.length > 0 && (
          <section aria-label={t.variationsLabel} className="mt-4">
            <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
              {t.variationsLabel}
            </h3>
            <ul className="flex flex-wrap gap-2">
              {product.variations.map((v, i) => (
                <li
                  key={v.id}
                  className={`rc-variant${i === 0 ? " is-selected" : ""}`}
                  style={{ font: "var(--rc-text-body)", fontWeight: 500 }}
                >
                  {v.label}
                  {v.priceDelta !== 0 && (
                    <span className="tabular ms-1">
                      <bdi>{v.priceDelta > 0 ? "+" : "−"}{formatKWD(Math.abs(v.priceDelta))}</bdi>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {(
          [
            [t.alternativesLabel, foldAlternativeRows(product.alternatives)],
            [t.pairsWithLabel, foldAlternativeRows(product.pairsWith ?? [])],
          ] as const
        ).map(([label, rows]) =>
          rows.length === 0 ? null : (
            <section key={label} aria-label={label} className="mt-4">
              <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
                {label}
              </h3>
              <ul>
                {rows.map((a) => (
                  <li
                    key={a.productId}
                    className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded px-1 py-1 hover:bg-[var(--rc-canvas)]"
                  >
                    <a
                      href={buildResultsHref(a.title, 1, country, showOutOfStock)}
                      className="min-w-0 hover:underline"
                      style={{ font: "var(--rc-text-body)", fontWeight: 500, color: "var(--rc-ink)" }}
                      title={displayTitleChanged(a.title, cleanDisplayTitle(a.title)) ? a.title : undefined}
                    >
                      {cleanDisplayTitle(a.title)}
                    </a>
                    <span
                      className="tabular ms-auto shrink-0"
                      style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                    >
                      <bdi>{`${t.fromWord} ${formatPrimaryPrice(a.fromPrice, "KWD").label}`}</bdi>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
      </article>
    );
  }

  return (
    <article
      className={`rc-card result-card min-w-0${oos ? " is-oos" : ""}${cascadeIndex != null ? " pulse-cascade" : ""}`}
      style={cascadeIndex != null ? ({ "--cascade-index": cascadeIndex } as React.CSSProperties) : undefined}
    >
      <div className="rc-card-top">
        <span className="rc-card-cat">{product.brand || t.allProducts}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />
          <span className="rc-card-basis">{t.bestEffectiveLabel}</span>
        </span>
      </div>

      <CardMedia product={product} locale={locale} query={query} country={country} />

      <h2 className="rc-card-title" title={titleChanged ? product.title : undefined}>
        <Link href={`/product/${encodeURIComponent(product.productId)}`} className="hover:underline">
          <bdi>{displayTitle}</bdi>
        </Link>
      </h2>

      {titleChanged && (
        <details className="rc-card-title-disclosure">
          <summary
            className="label-token cursor-pointer list-none inline-flex items-center rounded px-2 py-0.5"
            style={{ color: "var(--rc-muted)", border: "1px solid var(--rc-line)" }}
          >
            {t.originalTitleLabel}
          </summary>
          <p className="mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
            {product.title}
          </p>
        </details>
      )}

      {best && heroPrice && (
        <>
          <div className="rc-price-line flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {heroUnavailable ? (
              <span className="price-cur rc-price-card tabular" style={{ font: "var(--rc-text-price-card)", color: "var(--rc-muted)" }}>
                <bdi>{t.priceUnavailable}</bdi>
              </span>
            ) : (
              <span
                className="price-cur rc-price-card tabular"
                /* REEA-1096 D1 — the price is ink (#1F1A14), not the savings
                   green: the inline colour override is gone, so the stylesheet's
                   .rc-price-card{color:var(--rc-ink)} token applies in both
                   themes. */
                style={{ font: "var(--rc-text-price-card)" }}
              >
                {(locale ?? "en") === "ar" ? <span className="price-from">{t.fromWord} </span> : null}
                <bdi>{heroPrice.primary}</bdi>
              </span>
            )}
            {!heroUnavailable && heroPrice.alt && <span className="price-alt">· <bdi>{heroPrice.alt}</bdi></span>}
            {saved && best.wasPrice != null && (
              <span className="rc-price-was tabular">
                <bdi>{formatCountryPrice(best.wasPrice, best.currency, country).primary}</bdi>
              </span>
            )}
            {heroReason && !heroUnavailable && (
              <span className="price-warn" title={verifyTitleFor(heroReason, t)}>
                <bdi>{t.priceVerifyBadge}</bdi>
              </span>
            )}
            {isBest ? (
              kuwaitChecking ? (
                <span className="best-flag best-flag-pending" role="status" title={t.kuwaitChecking}>
                  <bdi>{t.kuwaitChecking}</bdi>
                </span>
              ) : !oos && !offerFlagged(best) ? (
                <span className="best-flag">{t.bestPrice}</span>
              ) : null
            ) : null}
          </div>
          {saved && heroSavedAmount && (
            <p className="flex flex-wrap items-center gap-2">
              <span className="rc-savings">
                <bdi>{`${t.saveLead} ${heroSavedAmount}`}</bdi>
              </span>
              <span className="rc-savings-basis">{fill(t.savingsBaseline, { x: best.merchant })}</span>
            </p>
          )}
        </>
      )}

      {product.variations.length > 0 && (
        <section aria-label={t.colourOptionsAria} className="rc-variants">
          {product.variations.map((v, i) => (
            <span
              key={v.id}
              className={`rc-variant${i === 0 ? " is-selected" : ""}`}
              /* REEA-1096 D2 — the pack's selected state is keyed on
                 aria-pressed=true (2px primary border, 600 weight, check
                 glyph). The old is-selected class matched no rule. */
              aria-pressed={i === 0 ? "true" : "false"}
            >
              {i === 0 ? (
                <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m4 12.5 5 5L20 6.5" />
                </svg>
              ) : null}
              {v.label}
              {/* REEA-1096 D3 — spec §3(6): a variant chip is name + price, no
                  verification status token. */}
              {cheapestListed != null ? (
                <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                  <bdi>{formatCountryPrice(cheapestListed + v.priceDelta, "KWD", country).primary}</bdi>
                </span>
              ) : null}
            </span>
          ))}
        </section>
      )}

      {offers.length > 0 && (
        <section aria-label={t.pricesSectionAria}>
          <h3 className="label-token" style={{ color: "var(--rc-body-text)", marginBottom: 4 }}>
            {t.pricesHeading}
          </h3>
          <div className="rc-offer-list">
            {offers.slice(0, MAX_SHELF_OFFERS).map((o) => (
              <ShelfOfferRow
                key={`${o.merchant}-${o.url}`}
                offer={o}
                product={product}
                query={query}
                rank={rank}
                country={country}
                renderStartMs={renderStartMs}
                locale={locale}
                queryId={queryId}
              />
            ))}
          </div>
          {offers.length > MAX_SHELF_OFFERS && (
            <Link href={`/product/${encodeURIComponent(product.productId)}`} className="rc-view-all">
              {fill(t.viewAllOffers, { n: offers.length })}
            </Link>
          )}
        </section>
      )}

      {/* REEA-1096 D6 — everything outside the accepted 7-item anatomy rides
          ONE disclosure instead of lengthening every card: coupon honesty
          lines, the retailer/price roll-up, the seen-range stamp, the
          alternatives/pairs lists and the lead CTA. Each offer row keeps its
          own outbound action, so the primary job stays one click away. */}
      {hasMore && (
      <details className="rc-card-more">
        <summary className="rc-card-more-summary">{t.cardMoreDetails}</summary>
        <div className="rc-card-more-body">
          {showLeadCta && bestHref && leadEffLabel != null && (
            <LeadOfferCta
              merchant={best.merchant}
              href={bestHref}
              effectiveLabel={leadEffLabel}
              couponed={leadCouponed}
              pending={kuwaitChecking}
              collectedAt={best.collectedAt}
              initialSeconds={leadAgeSecs}
              query={query}
              rank={rank}
              itemId={product.productId}
              queryId={queryId}
              locale={locale}
            />
          )}

          {couponRows.map((row) => (
            <CouponLine key={`${row.merchant}-${row.coupon.code ?? ""}-${row.coupon.discount}`} row={row} locale={locale} />
          ))}

          {!primaryCoupon && offers.length > 0 && (
            <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>{t.couponNoneLabel}</p>
          )}

          {best && cheapestListed != null && (
            <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
              <span className="tabular">{offers.length}</span>{" "}
              {offers.length === 1 ? t.retailersOne : t.retailersMany} · {t.fromWord}{" "}
              <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                <bdi>{formatCountryPrice(cheapestListed, "KWD", country).primary}</bdi>
              </span>
            </p>
          )}
          {best && cheapestListed == null && offers.length > 0 && (
            <p style={{ font: "var(--rc-text-body)", color: "var(--rc-muted)" }}>
              <span className="price-warn" title={t.verifyOutlier}>
                <bdi>{t.priceVerifyBadge}</bdi>
              </span>
            </p>
          )}

          {product.seenRange != null && (
            <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
              {`${t.seenRecentlyLead} `}
              <span className="tabular"><bdi>{formatSeenRangeLabel(product.seenRange, country)}</bdi></span>
              {` · ${t.seenRecentlyWindow}`}
            </p>
          )}

          {(
            [
              [t.alternativesLabel, altRows],
              [t.pairsWithLabel, pairRows],
            ] as const
          ).map(([label, rows]) =>
            rows.length === 0 ? null : (
              <section key={label} aria-label={label}>
                <h3 className="label-token" style={{ color: "var(--rc-body-text)", marginBottom: 4 }}>
                  {label}
                </h3>
                <ul>
                  {rows.map((a) => (
                    <li
                      key={a.productId}
                      className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded px-1 py-1 hover:bg-[var(--rc-canvas)]"
                    >
                      <a
                        href={buildResultsHref(a.title, 1, country, showOutOfStock)}
                        className="min-w-0 hover:underline"
                        style={{ font: "var(--rc-text-body)", fontWeight: 500, color: "var(--rc-ink)" }}
                        title={displayTitleChanged(a.title, cleanDisplayTitle(a.title)) ? a.title : undefined}
                      >
                        {cleanDisplayTitle(a.title)}
                      </a>
                      <span
                        className="tabular ms-auto shrink-0"
                        style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                      >
                        <bdi>{`${t.fromWord} ${formatPrimaryPrice(a.fromPrice, "KWD").label}`}</bdi>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      </details>
      )}
    </article>
  );
}
