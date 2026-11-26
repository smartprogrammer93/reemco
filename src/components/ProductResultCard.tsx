import Link from "next/link";
import Image from "next/image";
import type { NormalizedProduct, PriceOffer, ProductAlternative } from "@/types/product";
import { buildProductHref, buildResultsHref, currencyForCountry, type CountryCode } from "@/lib/country";
import { formatCountryPrice, formatKWD, formatPrimaryPrice } from "@/lib/format";
import {
  bestCouponForOffer,
  compositionOfOffer,
  effectiveKwdOfOffer,
  realCouponsFor,
  withCouponComposition,
} from "@/lib/price-composition";
import {
  HOME_MARKET,
  cheapestCrossMarketOffer,
  crossMarketHeadline,
  crossMarketLeadLabel,
  headlineOfferFor,
  isCrossMarketOffer,
  marketName,
  marketPriceLabel,
  marketStockLabel,
  offerMarket,
  scopeProductsByMarket,
  sortOffersByMarket,
} from "@/lib/market";
import { canonicalKey, dedupVariantKey, gradeBadgeLabel } from "@/lib/collect/canonical-product";
import { ageSeconds, collectedClock, localizedAgeFromStamp } from "@/lib/relative-time";
import CouponLine, { buildCouponRows } from "@/components/CouponLine";
import PriceCompositionLine from "@/components/PriceCompositionLine";
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
// REEA-1178 — the ONE offer-row integrity definition (merchant count, mismatch
// marker), shared with the weekly comparison-depth fold.
import { comparisonMerchantCount, isPossibleMismatchOffer } from "@/lib/offer-integrity";

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
  crossMarket = false,
  bestKnown = true,
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
  /** REEA-1142 — the lead is a cross-market offer, so the sentence names its
   *  market instead of claiming an unqualified Kuwait "best" price. */
  crossMarket?: boolean;
  /** REEA-1177 AC 6a-4 — false when the applied discount is unknown, so the
   *  CTA cannot claim "best effective price". */
  bestKnown?: boolean;
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
              {crossMarket || !bestKnown ? null : <span>{t.ctaBestLead}</span>}
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
  void coupon; // the served composition already folds the card's real coupon
  const seen = new Set<string>();
  const rows: PriceOffer[] = [];
  for (const o of offers) {
    // REEA-1177 AC 6a-4 — the fold key is the SAME effectivePrice the card
    // prints and ranks on, never a face-value subtraction.
    const effective = effectiveKwdOfOffer(o);
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
export function cheapestListedKwd(
  product: NormalizedProduct,
  scope: CountryCode | null = HOME_MARKET,
): number | null {
  // REEA-1177 AC 6a-4 — the "from" figure is the cheapest EFFECTIVE price of
  // the card's in-market offers, the same composition the card prints.
  const coupons = realCouponsFor(product.coupons, product.offers);
  const offers = foldRetailerRows(
    sortOffersByMarket(withCouponComposition(product.offers, coupons), null, scope),
    null,
  );
  // REEA-1142 — the base is a local figure; cross-market offers never set it.
  const priced = offers.filter((o) => !offerFlagged(o) && !isCrossMarketOffer(o, scope));
  return priced.length > 0
    ? Math.min(...priced.map((o) => effectiveKwdOfOffer(o)))
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
  scope,
  renderStartMs,
  locale,
  queryId,
  showSaving = false,
}: {
  offer: PriceOffer;
  product: NormalizedProduct;
  query: string;
  rank: number;
  country: CountryCode | null;
  /** REEA-1142 — the market this card speaks for; a cross-market listing is
   *  labeled with its own market and never reads as local verified stock. */
  scope: CountryCode | null;
  renderStartMs?: number;
  locale?: Locale;
  queryId?: string;
  /** REEA-1177 AC 6a-1 — a non-headline row states its own was-price saving;
   *  the headline row's statement is the card-level composition line, so it
   *  is not restated here. */
  showSaving?: boolean;
}) {
  const t = getStrings(locale ?? clientLocale());
  const href = resolveOfferUrl(offer, product.title);
  // REEA-1142 AC1 — a cross-market row keeps its own currency on the row and
  // carries the ≈KD reference behind it (native-first), so the shopper sees
  // "SAR 5.80 · ≈KD 0.47" and never a bare Kuwait price for a Saudi listing.
  const cross = isCrossMarketOffer(offer, scope);
  // REEA-1177 AC 6a-1 — the row keeps the retailer's own current price (the
  // coupon's applied value is stated on the composition/coupon line, not
  // subtracted into a second number here). A non-headline row still shows its
  // own was-price markdown so the shopper sees the same reconciliation the
  // card-level line gives the headline.
  const composed = compositionOfOffer(offer);
  const rowWas =
    showSaving &&
    composed.kind === "was_price" &&
    (composed.appliedDiscount ?? 0) > 0 &&
    composed.listed > offer.price + 0.005;
  const rowWasLabel = rowWas
    ? formatCountryPrice(composed.listed, offer.currency, cross ? null : country).primary
    : null;
  const rowSavingLabel = rowWas
    ? formatCountryPrice(composed.appliedDiscount ?? 0, offer.currency, cross ? null : country).primary
    : null;
  const row = formatCountryPrice(offer.price, offer.currency, cross ? null : country);
  const market = offerMarket(offer.currency);
  const rowReason = offerFlagged(offer) ? offer.sanity?.reason : undefined;
  const rowUnavailable = rowReason === "price_unavailable";
  // REEA-1178 AC3 — an offer that is not comparable evidence for this card
  // (flagged by the cohort pass, or a price below a tenth of the median — the
  // live Anker/Amazon.eg accessory at ratio 0.09997) keeps its own row and its
  // own price, but is MARKED as a possible mismatch so it never reads as a
  // like-for-like comparison. It is excluded from the retailer count and from
  // comparison_depth (lib/offer-integrity.ts).
  const possibleMismatch = isPossibleMismatchOffer(offer);
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
    <li
      className={`offer-row rc-offer-row${cross && market ? " has-market" : ""}${offer.inStock ? "" : " is-out"}`}
    >
      <div className="rc-offer-line line-a">
        <span className="rc-retailer-name">
          <bdi className="logo lat">{offer.merchant}</bdi>
        </span>
        {cross && market ? (
          // REEA-1161 — the market qualifier is the trust signal for a
          // non-KWD row, so it carries its full text: `rc-market-badge` opts
          // it out of the 375 single-line ellipsis rule (globals.css) and the
          // title is a fallback for any environment that still truncates.
          <span
            className="label-token rc-market-badge rounded px-2 py-0.5"
            title={marketPriceLabel(market, locale)}
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
          >
            <bdi>{marketPriceLabel(market, locale)}</bdi>
          </span>
        ) : null}
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
        {possibleMismatch ? (
          // REEA-1178 AC3 — the marker the ticket asks for: a distinct chip on
          // the row itself (not only the tooltip) so a shopper scanning prices
          // sees that this figure may be a different product. Same quiet chip
          // styling as the label tokens; the reason sentence rides the native
          // title attribute.
          <span
            className="label-token rc-mismatch-badge shrink-0 whitespace-nowrap rounded px-2 py-0.5"
            role="note"
            title={verifyTitleFor(offer.sanity?.reason, t)}
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px dashed var(--rc-line)" }}
          >
            {t.mismatchBadge}
          </span>
        ) : null}
        <span className={`rc-stock${offer.inStock ? "" : " is-out"}`}>
          <span className="dot" aria-hidden />
          {offer.inStock ? t.inStock : t.outOfStock}
        </span>
        {cross && market ? (
          // REEA-1142 — never "Verified" for Kuwait on a foreign listing: the
          // badge names the market the stock actually belongs to ("KSA stock").
          // REEA-1161 — full text at 375 (rc-market-badge) + title fallback.
          <span
            className="label-token rc-market-badge rounded px-2 py-0.5"
            title={marketStockLabel(market, locale)}
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
          >
            <bdi>{marketStockLabel(market, locale)}</bdi>
          </span>
        ) : null}
        {/* REEA-963 keeps ONE verification surface: a flagged cross-market row
            still carries its warning token; only the unqualified "Verified"
            is replaced by the market badge above. */}
        {!cross || status !== "verified" ? (
          <OfferStatusToken
            status={status}
            locale={locale}
            title={rowReason && !rowUnavailable ? verifyTitleFor(rowReason, t) : undefined}
          />
        ) : null}
      </div>
      <div className="rc-offer-line line-b">
        {/* REEA-1094 — line B keeps the price as the largest figure and the
            action in the inline-end slot; the conversion stamp and the
            collection stamp share ONE meta sub-line under the price at 375,
            so a foreign-currency row never has to widen past the card. The
            wrappers are display:contents above 641px (globals.css), so the
            desktop line/table geometry is unchanged. */}
        <span className="rc-price-block">
          {rowWas && rowWasLabel && (
            <span className="rc-row-was tabular">
              <bdi>{rowWasLabel}</bdi>
            </span>
          )}
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
          {rowWas && rowSavingLabel && (
            <span className="rc-row-savings">
              <bdi>{`${t.saveLead} ${rowSavingLabel}`}</bdi>
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
  country,
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
  // REEA-1177 AC 6d-1/6d-2 — the card speaks for the selected market; the
  // no-prop default is Kuwait (home), while an explicit null is the ALL view.
  // A market-scoped card renders that market's offers; cross-market rows stay
  // only when the product has no in-market offer (the AC 6d-3 exception).
  const viewCountry: CountryCode | null = country === undefined ? HOME_MARKET : country;
  const scope = viewCountry;
  const scopedOffers = scopeProductsByMarket([product], scope)[0].offers;
  // REEA-1177 AC 6a-3 — the derived was-price coupon entries (code:null, bare
  // amount == savings.amount) are NOT coupons; only real coupons are applied
  // to the composition and rendered as badges.
  const realCoupons = realCouponsFor(product.coupons, scopedOffers);
  const composedOffers = withCouponComposition(scopedOffers, realCoupons);
  const offers = foldRetailerRows(
    sortOffersByMarket(composedOffers, null, scope),
    null,
  );
  // AC2 — the headline offer is the cheapest in-stock offer OF THE SELECTED
  // MARKET, on the same effectivePrice the composition prints. A converted
  // non-KWD offer can never lead it; when the card has no local offer at all
  // the honest no-local-offer line renders instead.
  const localBest = headlineOfferFor(offers, scope);
  const crossBest = cheapestCrossMarketOffer(offers, scope);
  // Display fallback: when every offer is flagged the headline claim is
  // suppressed, but the card must still render a price (with its warning) —
  // never a blank hero.
  const best = localBest ?? crossBest ?? offers[0] ?? null;
  const hasLocalOffer = localBest !== null;
  const headline = hasLocalOffer ? null : crossMarketHeadline(offers, scope, locale);
  const kuwaitChecking =
    kuwaitBatchPending &&
    (kuwaitPendingStatus ||
      !hasLocalOffer ||
      (best != null && best.currency.trim().toUpperCase() !== "KWD"));
  // REEA-1122 — one absolute-price base, shared with the product hero, so a
  // variant chip never prints a bare delta ("KD 0"). REEA-1177 scopes it to
  // the selected market and uses effectivePrice.
  const cheapestListed = cheapestListedKwd(product, scope);
  const oos = best != null && !best.inStock;
  const bestComposition = best ? compositionOfOffer(best) : null;
  const bestDiscount = bestComposition?.appliedDiscount ?? 0;
  const bestKnown = bestComposition?.effective != null;
  const primaryCoupon = best ? bestCouponForOffer(best, realCoupons) : null;
  const couponRows = buildCouponRows(realCoupons, offers, viewCountry);
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
  // REEA-1177 AC 6a-4 — the lead CTA prints the same effective figure the card
  // headlines; a couponed figure says so, and an unknown applied value never
  // claims "best effective price".
  const leadEff =
    bestComposition != null
      ? (bestComposition.effective ?? bestComposition.listed)
      : null;
  const leadCouponed = bestComposition?.kind === "coupon" && bestDiscount > 0;
  const leadEffLabel =
    leadEff == null
      ? null
      : hasLocalOffer
        ? formatCountryPrice(leadEff, best?.currency ?? "KWD", viewCountry).primary.replace(/\u00A0/g, " ")
        : best != null
          ? crossMarketLeadLabel(best, scope, locale)
          : null;
  const leadAgeSecs = best != null ? ageSeconds(best.collectedAt, renderStartMs) : null;

  const heroReason = best && offerFlagged(best) ? best.sanity?.reason : undefined;
  const heroUnavailable = heroReason === "price_unavailable";
  // REEA-1177 AC 6a-2/6a-4 — headline = effective. When the discount is
  // conditional and its applied value is unknown, the headline is the listed
  // figure (no face value subtracted) and the card withholds the "best
  // effective price" claim.
  const heroEffective = bestComposition
    ? (bestComposition.effective ?? bestComposition.listed)
    : best?.price;
  const heroPrice =
    best != null && heroEffective != null
      ? formatCountryPrice(heroEffective, best.currency, hasLocalOffer ? viewCountry : null)
      : null;
  const heroListedLabel =
    best != null && bestComposition != null && bestDiscount > 0
      ? formatCountryPrice(
          bestComposition.listed,
          best.currency,
          hasLocalOffer ? viewCountry : null,
        ).primary
      : null;
  // REEA-1147 AC2 — a card is a cross-store comparison only when at least two
  // distinct retailers answer IN the surface's market. REEA-1177 AC 6a-4 adds
  // the second condition (the claim rests only when the effective price is
  // known) below.
  // REEA-1178 AC2/AC3 — the count reads the ONE integrity definition
  // (lib/offer-integrity.ts), the same one the weekly depth fold uses: rows
  // deduped by merchant+price+URL, in-market only, and a possible-mismatch
  // offer (outlier_low, a price-integrity flag, or any ratioToMedian < 0.1)
  // never becomes a comparison lane. Live `fb1747d2`: the Anker AeroFit 2
  // card's Amazon.eg accessory at ratio 0.09997 counted as a second retailer.
  const inMarketRetailers = comparisonMerchantCount(offers, scope);
  const comparison = inMarketRetailers >= 2;
  const bestEffectiveClaim = comparison && bestKnown;

  if (detail) {
    return (
      <article className={`result-card${oos ? " is-oos" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          {product.brand ? <RetailerChip>{product.brand}</RetailerChip> : null}
          {best && <StockDot state={best.inStock ? "in" : "out"} locale={locale} />}
          <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />
          <ShareSummaryButton product={product} query={query} country={viewCountry} locale={locale} />
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
                      href={buildResultsHref(a.title, 1, viewCountry, showOutOfStock)}
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
          <span className="rc-card-basis">
            {bestEffectiveClaim
              ? t.bestEffectiveLabel
              : inMarketRetailers === 1
                ? `${inMarketRetailers} ${t.retailersOne}`
                : !hasLocalOffer && best && offerMarket(best.currency)
                  ? marketPriceLabel(offerMarket(best.currency) as CountryCode, locale)
                  : `${inMarketRetailers} ${t.retailersMany}`}
          </span>
        </span>
      </div>

      <CardMedia product={product} locale={locale} query={query} country={viewCountry} />

      <h2 className="rc-card-title" title={titleChanged ? product.title : undefined}>
        <Link href={buildProductHref(product.productId, query, viewCountry)} className="hover:underline">
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
          {headline && (
            <p
              className="rc-market-headline"
              role="status"
              style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)", marginBlock: "0 4px" }}
            >
              <bdi>{headline}</bdi>
            </p>
          )}
          {!hasLocalOffer && best && offerMarket(best.currency) ? (
            // REEA-1177 AC 6d-3 — a foreign-currency card is the only offer
            // for this product; it names its market and carries the delivery
            // caveat so a Kuwait shopper never reads it as local stock.
            <p className="rc-market-caveat" role="note">
              <bdi>
                {fill(t.crossMarketCaveat, {
                  market: marketName(offerMarket(best.currency) as CountryCode, locale),
                })}
              </bdi>
            </p>
          ) : null}
          <div className="rc-price-line flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {!hasLocalOffer && best && offerMarket(best.currency) ? (
              <span
                className="label-token shrink-0 whitespace-nowrap rounded px-2 py-0.5"
                style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
              >
                <bdi>{marketPriceLabel(offerMarket(best.currency) as CountryCode, locale)}</bdi>
              </span>
            ) : null}
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
            {heroListedLabel && (
              <span className="rc-price-was tabular">
                <bdi>{heroListedLabel}</bdi>
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
              ) : hasLocalOffer && !oos && !offerFlagged(best) ? (
                // REEA-1142 AC2 — a cross-market-only card never claims an
                // unqualified "Best price" on the Kuwait surface.
                <span className="best-flag">{t.bestPrice}</span>
              ) : null
            ) : null}
          </div>
          {bestComposition && bestDiscount > 0 && !heroUnavailable && (
            // REEA-1177 AC 6a-2/6a-6 — ONE reconciling statement, visible
            // without expanding the disclosure: listed − applied = effective.
            <PriceCompositionLine
              composition={bestComposition}
              merchant={best.merchant}
              currency={best.currency}
              country={hasLocalOffer ? viewCountry : null}
              locale={locale}
              comparison={comparison && bestKnown}
              couponText={primaryCoupon?.discount}
            />
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
                  <bdi>{formatCountryPrice(cheapestListed + v.priceDelta, "KWD", viewCountry).primary}</bdi>
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
                country={viewCountry}
                scope={scope}
                renderStartMs={renderStartMs}
                locale={locale}
                queryId={queryId}
                showSaving={best != null && o !== best}
              />
            ))}
          </div>
          {offers.length > MAX_SHELF_OFFERS && (
            <Link href={buildProductHref(product.productId, query, viewCountry)} className="rc-view-all">
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
              crossMarket={!hasLocalOffer}
              bestKnown={bestKnown}
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

          {best && hasLocalOffer && cheapestListed != null && (
            <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
              <span className="tabular">{inMarketRetailers}</span>{" "}
              {inMarketRetailers === 1 ? t.retailersOne : t.retailersMany} · {t.fromWord}{" "}
              <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                <bdi>{formatCountryPrice(cheapestListed, "KWD", viewCountry).primary}</bdi>
              </span>
            </p>
          )}
          {best && !hasLocalOffer && headline && (
            <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
              <bdi>{headline}</bdi>
            </p>
          )}
          {best && hasLocalOffer && cheapestListed == null && offers.length > 0 && (
            <p style={{ font: "var(--rc-text-body)", color: "var(--rc-muted)" }}>
              <span className="price-warn" title={t.verifyOutlier}>
                <bdi>{t.priceVerifyBadge}</bdi>
              </span>
            </p>
          )}

          {product.seenRange != null && (
            <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
              {/* REEA-1167 — one scoped observation is a "first seen" figure,
                  not a 14-day range claim. */}
              {`${product.seenRange.firstSeen ? t.firstSeenLead : t.seenRecentlyLead} `}
              <span className="tabular"><bdi>{formatSeenRangeLabel(product.seenRange, viewCountry)}</bdi></span>
              {product.seenRange.firstSeen ? null : ` · ${t.seenRecentlyWindow}`}
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
                        href={buildResultsHref(a.title, 1, viewCountry, showOutOfStock)}
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
