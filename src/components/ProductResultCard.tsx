import Link from "next/link";
import Image from "next/image";
import type { NormalizedProduct, PriceOffer, ProductAlternative } from "@/types/product";
import { buildProductHref, buildResultsHref, type CountryCode } from "@/lib/country";
import { formatCountryPrice, formatKWD } from "@/lib/format";
// REEA-1236 — the ONE rail "from" figure contract: KWD-space numeric with its
// source currency, so a cross-market entry prints "≈KD X" (or its own
// currency when no conversion exists) instead of a bare native amount under a
// KD label.
import { railFromPriceLabel, railFromPriceLabelGuarded } from "@/lib/alternatives";
import {
  bestCouponForOffer,
  compositionOfOffer,
  effectiveKwdOfOffer,
} from "@/lib/price-composition";
import {
  HOME_MARKET,
  crossMarketHeadlineParts,
  crossMarketLeadLabel,
  isCrossMarketOffer,
  marketName,
  marketPriceLabel,
  marketStockLabel,
  offerMarket,
} from "@/lib/market";
// REEA-1212 — the ONE visible-offer projection, shared with the results
// JSON-LD so the structured data describes the rows this card paints.
import {
  SHELF_VISIBLE_OFFER_ROWS,
  foldRetailerRows,
  visibleShelfOffers,
} from "@/lib/results-offers";
import { canonicalKey, gradeBadgeLabel } from "@/lib/collect/canonical-product";
import { ageSeconds, collectedClock, localizedAgeFromStamp } from "@/lib/relative-time";
import CouponLine, { buildCouponRows } from "@/components/CouponLine";
import PriceCompositionLine from "@/components/PriceCompositionLine";
import ShareWhatsAppButton from "@/components/ShareWhatsAppButton";
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
import {
  comparisonMerchantCount,
  isPossibleMismatchOffer,
  renderedMerchantCount,
} from "@/lib/offer-integrity";
// REEA-1246 — the click carries this card's offer set to the product page.
import { encodeClickSeed } from "@/lib/pdp-click-seed";

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
 * REEA-1096 D6 — the shelf's visible-row cap lives in
 * lib/results-offers.ts (SHELF_VISIBLE_OFFER_ROWS) so the card and the
 * results JSON-LD cannot disagree about how many rows the page shows.
 */

/** Re-exported for the existing REEA-787 fold tests; the definition now
 *  lives in lib/results-offers.ts so the structured data uses it too. */
export { foldRetailerRows };

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
function CardMedia({
  product,
  locale,
  query,
  country,
  shareOrigin,
  shareLoading = false,
}: {
  product: NormalizedProduct;
  locale?: Locale;
  query?: string;
  country?: CountryCode | null;
  /** REEA-1255 — server-resolved origin for the share's PDP URL. */
  shareOrigin?: string;
  /** REEA-1255 — true while the Kuwait batch may still land with no in-stock offer. */
  shareLoading?: boolean;
}) {
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
          <ShareWhatsAppButton
            product={product}
            query={query}
            country={country}
            locale={locale}
            origin={shareOrigin}
            variant="card"
            loading={shareLoading}
          />
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
        <ShareWhatsAppButton
          product={product}
          query={query}
          country={country}
          locale={locale}
          origin={shareOrigin}
          variant="card"
          loading={shareLoading}
        />
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
  // REEA-1212 — read the ONE visible-offer projection (market scope, real
  // coupons, fold, ordering) instead of re-deriving a second chain.
  const offers = visibleShelfOffers(product, scope).all;
  // REEA-1142 — the base is a local figure; cross-market offers never set it.
  // REEA-1178 AC3 — a possible-mismatch offer never sets the "from" figure
  // either: a KD 2.9 accessory must not print as this card's lowest price.
  const priced = offers.filter(
    (o) => !isPossibleMismatchOffer(o) && !isCrossMarketOffer(o, scope),
  );
  return priced.length > 0
    ? Math.min(...priced.map((o) => effectiveKwdOfOffer(o)))
    : null;
}

/**
 * REEA-787 — alternatives/pairs fold: duplicate cards for ONE matched product
 * (the REEA-167 canonicalKey title identity) with an IDENTICAL formatted
 * fromPrice collapse to the first entry. REEA-1236 — the dedupe key is the
 * SAME label the rail paints, so a "≈KD 267.57" SAR entry and a "KD 267.57"
 * KWD entry are never folded into one row.
 */
export function foldAlternativeRows(rows: ProductAlternative[]): ProductAlternative[] {
  const seen = new Set<string>();
  const out: ProductAlternative[] = [];
  for (const a of rows) {
    const key = `${canonicalKey(a.title)}|${railFromPriceLabel(a)}`;
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
  shareOrigin,
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
  /** REEA-1255 — server-resolved origin for the share's PDP URL. */
  shareOrigin?: string;
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
  // REEA-1212 — one shared projection with the results JSON-LD: market
  // scoping, real-coupon composition, fold, ordering, headline offer and the
  // visible-row cap all come from lib/results-offers.ts. This is the exact
  // offer set the shopper sees, and the structured data derives from it.
  const {
    all: offers,
    best,
    localBest,
    realCoupons,
    cardRows: shelfOffers,
  } = visibleShelfOffers(product, scope);
  // REEA-1246 — the click carries the offer set this card renders, so the
  // product page's first paint shows the price the shopper just clicked even
  // when the shelf run has not written its query memo yet. Built from the
  // same projection the card paints (one definition, no second price pass).
  const clickSeed = encodeClickSeed(product.productId, offers);
  const hasLocalOffer = localBest !== null;
  const kuwaitChecking =
    kuwaitBatchPending &&
    (kuwaitPendingStatus ||
      !hasLocalOffer ||
      (best != null && best.currency.trim().toUpperCase() !== "KWD"));
  // REEA-1255 — the share control stays inert until the first in-market
  // in-stock offer resolves; a pending Kuwait batch with no local offer must
  // never send a not-stocked message it cannot stand behind.
  const shareLoading = kuwaitBatchPending && !hasLocalOffer;
  // REEA-1198 — the headline is rendered as its two parts so the price token
  // ("KD 0.47") is its own nowrap span: the sentence may wrap, the figure may
  // not split ("KD" / "0.47") at 375 AR on the disclosed-fallback path.
  // REEA-1217 — while the batch may still land (kuwaitChecking), the card must
  // not claim "No Kuwait offer": the interim sentence states the foreign price
  // it holds and leaves the absence claim to the settled state.
  const headlineParts = hasLocalOffer
    ? null
    : crossMarketHeadlineParts(offers, scope, locale, { pending: kuwaitChecking });
  // REEA-1122 — one absolute-price base, shared with the product hero, so a
  // variant chip never prints a bare delta ("KD 0"). REEA-1177 scopes it to
  // the selected market and uses effectivePrice.
  const cheapestListed = cheapestListedKwd(product, scope);
  // REEA-1236 AC4 — the card's own lead figure in KWD-space, the ceiling the
  // alternatives render guard compares against. `cheapestListed` is the
  // in-market effective figure; a cross-market-only card falls back to the
  // lead offer's converted figure so the guard still has a real base.
  const cardLeadKwd = cheapestListed ?? (best != null ? effectiveKwdOfOffer(best) : null);
  const oos = best != null && !best.inStock;
  // REEA-1246 AC2 — a foreign-only card is one thing; an out-of-stock-only KWD
  // card is NOT foreign, so the market badge/caveat must not claim
  // "Delivery from Kuwait" on it.
  const crossMarketBest = !hasLocalOffer && best != null && isCrossMarketOffer(best, scope);
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
  // REEA-1217 — the printed basis must agree with the rows the card renders.
  // A card whose only in-market rows are possible-mismatch rows has zero
  // comparison lanes but still prints a row; the lane count alone would read
  // "0 retailers" over a visible price (live `belkin-rockstar-c`). The claim
  // gate below keeps reading the lane count, so a mismatch row still never
  // earns "best effective price" — only the count line stops contradicting
  // the card's own list.
  const renderedRetailers = renderedMerchantCount(offers, scope);
  const basisRetailers =
    inMarketRetailers > 0 ? inMarketRetailers : renderedRetailers;
  const comparison = inMarketRetailers >= 2;
  const bestEffectiveClaim = comparison && bestKnown;

  // REEA-1207 AC 7B-1/7B-6 — the rendered card carries its own measurement
  // contract (`data-product-id` + `data-comparison`), derived from the ONE
  // in-market comparison definition above. The committed category-depth probe
  // reads these attributes instead of re-deriving merchants from prose, so it
  // measures the cards the page actually painted (including snapshot replays
  // that emit no JSON-LD) with the same integrity rule the weekly fold uses.
  // Non-visual: attributes only, no class or layout change.
  const comparisonAttrs = {
    "data-product-id": product.productId,
    "data-comparison": comparison ? "1" : "0",
    "data-in-market-retailers": String(inMarketRetailers),
    // REEA-1207 AC 7B-1 — the card states its own scope class so the committed
    // probe measures the COMPARISON shelf (primary/variant), not the related
    // alternatives band that reuses this same card component. Non-visual:
    // attribute only.
    "data-product-scope": product.productScope ?? "unscoped",
    // REEA-1207 AC 7B-1R — the rev-2 gate counts only IN-MARKET (Kuwait)
    // retailers: a card carrying one Kuwait store and one cross-market row is
    // a single-retailer card, and a cross-market-only card is never depth. The
    // card's own comparison count follows the viewer's market selection (null
    // = all markets on the default surface), so the probe needs this
    // Kuwait-scoped figure to measure the gate the product is judged on.
    // Non-visual: attribute only.
    "data-comparison-kw":
      comparisonMerchantCount(offers, HOME_MARKET) >= 2 ? "1" : "0",
    "data-in-market-retailers-kw": String(
      comparisonMerchantCount(offers, HOME_MARKET),
    ),
  } as const;

  if (detail) {
    return (
      <article className={`result-card${oos ? " is-oos" : ""}`} {...comparisonAttrs}>
        <div className="flex flex-wrap items-center gap-2">
          {product.brand ? <RetailerChip>{product.brand}</RetailerChip> : null}
          {best && <StockDot state={best.inStock ? "in" : "out"} locale={locale} />}
          <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />
          <ShareWhatsAppButton
            product={product}
            query={query}
            country={viewCountry}
            locale={locale}
            origin={shareOrigin}
            variant="pdp"
          />
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
            [t.alternativesLabel, foldAlternativeRows(product.alternatives), true],
            [t.pairsWithLabel, foldAlternativeRows(product.pairsWith ?? []), false],
          ] as const
        ).map(([label, rows, cheaperClaim]) =>
          rows.length === 0 ? null : (
            <section key={label} aria-label={label} className="mt-4">
              <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
                {label}
              </h3>
              <ul>
                {rows.map((a) => {
                  // REEA-1236 — a cheaper-alternatives row goes through the
                  // AC4 unit guard; a "Pairs with" accessory is complementary,
                  // not a cheaper-than-card claim, so it only gets the honest
                  // converted label.
                  const figure = cheaperClaim
                    ? railFromPriceLabelGuarded(a, cardLeadKwd)
                    : railFromPriceLabel(a);
                  return (
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
                      {figure != null && (
                        <span
                          className="tabular ms-auto shrink-0"
                          style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                        >
                          <bdi>{`${t.fromWord} ${figure}`}</bdi>
                        </span>
                      )}
                    </li>
                  );
                })}
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
      {...comparisonAttrs}
    >
      <div className="rc-card-top">
        <span className="rc-card-cat">{product.brand || t.allProducts}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />
          <span className="rc-card-basis">
            {bestEffectiveClaim
              ? t.bestEffectiveLabel
              : basisRetailers === 1
                ? `${basisRetailers} ${t.retailersOne}`
                : crossMarketBest && best && offerMarket(best.currency)
                  ? marketPriceLabel(offerMarket(best.currency) as CountryCode, locale)
                  : `${basisRetailers} ${t.retailersMany}`}
          </span>
        </span>
      </div>

      <CardMedia
        product={product}
        locale={locale}
        query={query}
        country={viewCountry}
        shareOrigin={shareOrigin}
        shareLoading={shareLoading}
      />

      <h2 className="rc-card-title" title={titleChanged ? product.title : undefined}>
        <Link href={buildProductHref(product.productId, query, viewCountry, clickSeed)} className="hover:underline">
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
          {headlineParts && (
            <p
              className="rc-market-headline"
              role="status"
              style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)", marginBlock: "0 4px" }}
            >
              {/* REEA-1198 — the sentence wraps, the price token never does. */}
              <bdi>{headlineParts.prefix}<span className="rc-price-token">{headlineParts.price}</span>{headlineParts.suffix}</bdi>
            </p>
          )}
          {crossMarketBest && best && offerMarket(best.currency) ? (
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
            {crossMarketBest && best && offerMarket(best.currency) ? (
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
            {oos ? (
              // REEA-1246 AC2 — no in-stock offer answered for this card, so
              // the figure is a disclosed reference, never a best-price claim.
              <span className="price-reference label-token" role="status">
                <bdi>{t.priceReference}</bdi>
              </span>
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
            {shelfOffers.map((o) => (
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
          {offers.length > SHELF_VISIBLE_OFFER_ROWS && (
            <Link href={buildProductHref(product.productId, query, viewCountry, clickSeed)} className="rc-view-all">
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
              <span className="tabular">{basisRetailers}</span>{" "}
              {basisRetailers === 1 ? t.retailersOne : t.retailersMany} · {t.fromWord}{" "}
              <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                <bdi>{formatCountryPrice(cheapestListed, "KWD", viewCountry).primary}</bdi>
              </span>
            </p>
          )}
          {best && !hasLocalOffer && headlineParts && (
            <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
              <bdi>{headlineParts.prefix}<span className="rc-price-token">{headlineParts.price}</span>{headlineParts.suffix}</bdi>
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
              [t.alternativesLabel, altRows, true],
              [t.pairsWithLabel, pairRows, false],
            ] as const
          ).map(([label, rows, cheaperClaim]) =>
            rows.length === 0 ? null : (
              <section key={label} aria-label={label}>
                <h3 className="label-token" style={{ color: "var(--rc-body-text)", marginBottom: 4 }}>
                  {label}
                </h3>
                <ul>
                  {rows.map((a) => {
                    // REEA-1236 — same rail contract as the detail view: the
                    // cheaper-alternatives row carries the AC4 unit guard, a
                    // complementary "Pairs with" row gets the honest label.
                    const figure = cheaperClaim
                      ? railFromPriceLabelGuarded(a, cardLeadKwd)
                      : railFromPriceLabel(a);
                    return (
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
                        {figure != null && (
                          <span
                            className="tabular ms-auto shrink-0"
                            style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                          >
                            <bdi>{`${t.fromWord} ${figure}`}</bdi>
                          </span>
                        )}
                      </li>
                    );
                  })}
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
