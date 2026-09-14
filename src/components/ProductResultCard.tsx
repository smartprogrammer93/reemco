import Link from "next/link";
import Image from "next/image";
import type { NormalizedProduct, PriceOffer, ProductAlternative } from "@/types/product";
import { buildResultsHref, currencyForCountry, type CountryCode } from "@/lib/country";
import { effectivePriceKwd, formatCountryPrice, formatKWD, formatPrimaryPrice, sortOffers } from "@/lib/format";
import { canonicalKey, dedupVariantKey, gradeBadgeLabel } from "@/lib/collect/canonical-product";
import { ageSeconds, collectedClock, relativeAge } from "@/lib/relative-time";
import CouponLine, { buildCouponRows } from "@/components/CouponLine";
import ShareSummaryButton from "@/components/ShareSummaryButton";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import OfferCtaLabel, { LiveAge } from "@/components/OfferCtaLabel";
import { resolveOfferUrl } from "@/lib/links";
import { formatSeenRangeLabel } from "@/lib/seen-range";
import { cleanDisplayTitle, displayTitleChanged } from "@/lib/display-title";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";
import FreshnessBadge from "@/components/FreshnessBadge";

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
 * Reemco Design v3 result card (§5.2–§5.4). Single token namespace from
 * globals.css — no hex literals. variant="card": results list.
 * variant="detail" (REEA-101 realtime AC-1): ships IDENTITIES ONLY in the
 * served HTML — brand chip, title, coupon pill, variations, alternatives.
 * Offer prices/availability render solely from the live collection job
 * (CollectionPanel below), so one screen never shows two contradicting
 * freshness passes. variant="card" keeps the full normalized-feed summary:
 * the results list has no live job and is the feed's serving surface.
 */

function StockDot({ state, locale }: { state: "in" | "out"; locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <span className="inline-flex items-center gap-1.5" style={{ font: "var(--rc-text-body)" }}>
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{
          background: state === "in" ? "var(--rc-savings)" : "var(--rc-error)",
        }}
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

/**
 * REEA-281 AC-1 — product thumbnails for one result row.
 * Hard cap TWO per card, deduped, in feed order: the card-level photo first,
 * then the first distinct offer-listing photo (adapters lift the card image
 * from the offers, so dedupe is what keeps one photo from eating both slots).
 * Never blocks first paint: next/image is lazy by default in this version
 * (docs: image.md#loading — "Defaults to lazy"), decoding is async, and the
 * fixed intrinsic width/height reserve layout space so a late photo shifts
 * nothing. `unoptimized` because photo hosts differ per retailer contract;
 * the direct src skips the optimizer's hostname allowlist instead of
 * widening a shared config for every CDN (stated divergence, adapter
 * symmetry). No image in the feed renders a plain text-only row — the
 * graceful fallback, never an invented placeholder.
 */
function ThumbRow({ product }: { product: NormalizedProduct }) {
  const urls: string[] = [];
  const add = (src?: string) => {
    if (src && src.trim() && !urls.includes(src.trim()) && urls.length < 2) {
      urls.push(src.trim());
    }
  };
  add(product.image);
  for (const o of product.offers) add(o.image);
  if (urls.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {urls.map((src) => (
        <Image
          key={src}
          src={src}
          alt=""
          width={64}
          height={64}
          sizes="64px"
          unoptimized
          className="h-16 w-16 rounded object-contain"
          style={{ background: "var(--rc-canvas)" }}
        />
      ))}
    </div>
  );
}

function PriceBlock({
  offer,
  isBest,
  hasCoupon,
  oos = false,
  country,
  locale,
  kuwaitPending = false,
}: {
  offer: PriceOffer;
  isBest: boolean;
  /** REEA-657 Bet 2 criterion (a), kept honest by REEA-760: ONE discount
   *  signal per card — when coupon evidence exists the computed savings
   *  figure would print the SAME number twice beside the struck list price,
   *  so the pill rides off and the coupon honesty line keeps the crown. */
  hasCoupon: boolean;
  oos?: boolean;
  country: CountryCode | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /** REEA-835/847 — the combined checking decision (see ProductResultCard):
   *  while the Kuwait batch may still land AND (zero Kuwait-primary offers
   *  rendered OR the flagged offer is non-KWD), the lead card withholds the
   *  unqualified Best-price flag and shows the honest checking state in the
   *  SAME slot (one box, no layout shift) — an interim non-KWD lead must
   *  never read as a Kuwait best price on first paint. The slot swaps back
   *  to the flag when the batch settles (the flag clears). */
  kuwaitPending?: boolean;
}) {
  const t = getStrings(locale ?? clientLocale());
  // REEA-963 FR-1.3 — the offer's own sanity verdict: flagged renders the
  // warning affordance beside the figure; a price-unavailable offer (E3)
  // renders the honest "price unavailable" state, never "KD 0".
  const reason = offer.sanity?.status === "flagged" ? offer.sanity.reason : undefined;
  const unavailable = reason === "price_unavailable";
  // REEA-75: ml-auto keeps the price right-aligned when the row wraps;
  // flex-wrap on the baseline row stops the Best badge clipping (M3).
  // E3 — a price-unavailable offer has no honest savings arithmetic either.
  const saved =
    !unavailable && offer.wasPrice != null && offer.wasPrice > offer.price;
  // REEA-283: the selected country's currency LEADS the price rows (SA→SAR,
  // KW→KWD, EG→EGP); with no selection the offer's native figure leads. The
  // converted side rides behind as the muted `.price-alt` stamp — REEA-195's
  // "nothing silently rewritten" rule, now in the shopper's market order.
  const hero = formatCountryPrice(offer.price, offer.currency, country);
  return (
    // REEA-95 step-5 mobile pass: at narrow widths the price block takes the
    // full row so its chips wrap inside the viewport instead of forcing the
    // card wider than the screen (sm: restores side-by-side with the title).
    // REEA-944: min-w-0 (in place of shrink-0) lets the block yield spare
    // width instead of overflowing the card when the pending pill's intrinsic
    // width exceeds the line — flex line-breaking uses hypothetical (unshrunk)
    // sizes, so the REEA-75/M4 wrap behaviour is unchanged; only the overflow
    // case now shrinks, and the nowrap price figures keep min-width:auto.
    <div className="ml-auto w-full min-w-0 text-right sm:w-auto">
      {/* REEA-944 — the pill's parent flag row: min-width:0 per the REEA-863
          spec; flex-wrap + the 8px horizontal gap (gap-x-2 = --rc-space-2) are
          already stated here, and the nowrap conversion figure (.price-alt)
          keeps its implicit flex-shrink:0 via min-width:auto — numbers never
          ellipsize, the pill absorbs the squeeze. */}
      <div className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
        {unavailable ? (
          // REEA-963 E3 — no usable price served: the honest state, never "KD 0".
          <span className="price-cur tabular" style={{ font: "var(--rc-text-price)", color: "var(--rc-muted)" }}>
            <bdi>{t.priceUnavailable}</bdi>
          </span>
        ) : (
          <span
            className="price-cur tabular"
            style={{
              font: "var(--rc-text-price)",
              color: isBest ? "var(--rc-savings)" : "var(--rc-ink)",
              textDecoration: oos ? "line-through" : undefined,
            }}
          >
            <bdi>{hero.primary}</bdi>
          </span>
        )}
        {!unavailable && hero.alt && <span className="price-alt">· <bdi>{hero.alt}</bdi></span>}
        {/* REEA-963 FR-1.3 — the warning affordance stays WITH the flagged
            figure (we do not hide data, we do not bless it either). */}
        {reason && reason !== "price_unavailable" && (
          <span className="price-warn" title={verifyTitleFor(reason, t)}>
            <bdi>{t.priceVerifyBadge}</bdi>
          </span>
        )}
        {/* §5.3: strikethrough compare-at BESIDE the price, savings pill right
            after it — savings emphasis without stealing the price's crown.
            REEA-283: single-figure lines follow the LEAD currency too, so one
            card never mixes two currency orders. */}
        {saved && offer.wasPrice != null && (
          <span
            className="tabular"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", textDecoration: "line-through" }}
          >
            <bdi>{formatCountryPrice(offer.wasPrice, offer.currency, country).primary}</bdi>
          </span>
        )}
        {/* REEA-657 Bet 2 criterion (a): ONE discount signal on the price row —
            when coupon evidence carries the chip, the computed savings figure
            would print the SAME number twice beside the struck list price, so
            the pill rides off and the chip keeps the crown; with only wasPrice
            evidence the pill stays exactly as before (§5.3). Struck list price
            is kept either way. */}
        {saved && !hasCoupon && offer.wasPrice != null && (
          <span className="savings-pill"><bdi>{`${t.saveLead} ${formatCountryPrice(offer.wasPrice - offer.price, offer.currency, country).primary}`}</bdi></span>
        )}
        {/* REEA-835 — honest first paint: while any Kuwait retailer is still
            pending, the lead card's flag slot carries the checking state
            instead of an unqualified "Best price" (route (a) withhold — an
            interim international price never reads as a Kuwait best price).
            Same slot either way, so the settled swap moves nothing. */}
        {isBest ? (
          kuwaitPending ? (
            <span className="best-flag best-flag-pending" role="status" title={t.kuwaitChecking}>
              <bdi>{t.kuwaitChecking}</bdi>
            </span>
          ) : (
            <span className="best-flag">{t.bestPrice}</span>
          )
        ) : null}
        {/* REEA-760: the coupon evidence rides its own honest line below the
            price cluster — one row per issuing retailer (chip → attribution →
            single effective number), never stacked amounts, never "+N more".
            The pill suppression above keeps REEA-657 criterion (a). */}
      </div>
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
 *
 * Pending state (scope 3): while the Kuwait batch may still land, the
 * decision line carries the exact REEA-835/847 checking state the flag slot
 * uses — the SAME `kuwaitChecking` decision, so one card never tells two
 * stories — and never an unqualified "Best …" claim. The destination stays
 * clickable either way (graceful degradation: an interim offer is a real
 * offer), and the settled swap is copy-only, so nothing shifts.
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
  /** Country-led effective figure (REEA-283/REEA-896 formatter chain). */
  effectiveLabel: string;
  /** True when the effective figure folds a coupon — names the basis. */
  couponed: boolean;
  /** REEA-835/847 checking state — suppresses the "Best effective price" claim. */
  pending: boolean;
  collectedAt?: string;
  initialSeconds: number | null;
  query: string;
  rank: number;
  itemId: string;
  /** REEA-965 v1 metrics context — forwarded to the outbound link. */
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
 * badge | effective figure):
 *  - merchant reads case-folded — the same retailer listing one listing twice
 *    with different spelling is one row; keep-first on the sorted order keeps
 *    the cheapest live answer surviving;
 *  - the tier rides dedupVariantKey (listingLabel's vocabulary): colour /
 *    shelf-code / RAM / marketing restatements fold out, storage tiers,
 *    LABEL_QUALIFIERS and bundle words keep rows apart;
 *  - grade keeps its own slot (the REEA-167 badge rule): renewed/refurbished
 *    never blends into the new-condition rows;
 *  - the figure is the EFFECTIVE number the headline slot prints — the same
 *    single sortOffers/effectivePrice arithmetic (card best coupon + lower
 *    was-price evidence folded, KWD-space, ≤2 decimals) — so rows sharing a
 *    LISTED price but landing on different effective numbers stay separate
 *    (the post-REEA-757 rule), and equal-effective twins collapse.
 * Pure, order-preserving, idempotent: same input array, same survivors, and
 * a second pass over the survivors changes nothing. The OOS toggle filters
 * BEFORE this pass (stock.ts, order-preserving), so the keep-first survivor
 * set is identical in both toggle states — ON reveals rows in place.
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
 * REEA-787 — alternatives/pairs fold: duplicate cards for ONE matched product
 * (the REEA-167 canonicalKey title identity — retailer spellings of the same
 * device read as one) with an IDENTICAL formatted fromPrice collapse to the
 * first entry. Different prices or variants never merge: the distinct-price
 * set per section is provably unchanged — only byte-equal twins fold. Same
 * keep-first, idempotent rule as the retailer rows.
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
  /** True when this offer carries the best effective price on the page (§3.3 Von Restorff). */
  isBest?: boolean;
  /**
   * REEA-835/847 — the two facts the lead card's flag slot needs, kept apart
   * so the decision can ride the EXACT offer that would wear the flag:
   *
   * - `kuwaitBatchPending`: the Kuwait retailer batch may still land for this
   *   render (an intermediate flush, or a `settled:false` finalized snapshot
   *   whose follow-up feed has not answered yet).
   * - `kuwaitPendingStatus`: the rendered set carries ZERO offers from the
   *   Kuwait-primary four (the REEA-793 snapshot flag).
   *
   * While the batch is pending, the lead card (isBest) withholds the
   * unqualified "Best price" flag and shows the honest checking state when
   * EITHER no Kuwait-primary offer rendered at all (REEA-835's Amazon.eg EGP
   * shape) OR the flagged offer itself is not a KWD price — a Kuwait-primary
   * merchant answering does NOT make the lead honest: Jarir's hits are SAR
   * (REEA-847 live repro: the first cold flush led with a Jarir SAR offer
   * wearing "Best price" while the KWD stores were still in flight). The
   * lead-currency side reads the SAME currency the price row leads with
   * (REEA-283: the selected market's currency, else the offer's native one),
   * so an explicitly selected non-KWD market keeps its honest flag. Default
   * false/false keeps every other surface byte-for-byte.
   */
  kuwaitBatchPending?: boolean;
  kuwaitPendingStatus?: boolean;
  variant?: "card" | "detail";
  /** REEA-37 funnel context for item_clicked events (-1 = product detail page). */
  query?: string;
  rank?: number;
  /**
   * REEA-965 — per-query-execution id from the server render (results page
   * only). Present on results cards, the outbound CTAs fire the v1
   * `result_click` / `first_result_click` metrics events beside the REEA-37
   * funnel event; absent elsewhere, those surfaces stay byte-for-byte.
   */
  queryId?: string;
  /** REEA-170 active country selection, carried into alternatives queries. */
  country?: CountryCode | null;
  /** REEA-186 stock selection, carried into alternatives queries on the list. */
  showOutOfStock?: boolean;
  /** REEA-283 server-render clock for the freshness chip (hydration-reused). */
  renderStartMs?: number;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /**
   * REEA-447 R4 — arrival cascade slot: the card rises in (rc-rise, opacity +
   * translateY only — no layout shift) on the same stagger ladder the retailer
   * chips use. Absent on surfaces without a staged arrival (the detail hero).
   */
  cascadeIndex?: number;
}) {
  const detail = variant === "detail";
  const t = getStrings(locale ?? clientLocale());
  // REEA-836 — display-side title hygiene: the card renders the cleaned
  // title; the retailer's raw string stays one interaction away (hover title
  // attribute + the disclosure below) and every other consumer of
  // product.title (matching, ranking, share summary, links) is untouched —
  // presentation only, no adapter or stored-data change.
  const displayTitle = cleanDisplayTitle(product.title);
  const titleChanged = displayTitleChanged(product.title, displayTitle);
  // REEA-604 — the card's best coupon folds into the ONE ordering key: rows
  // sort on the normalized effective price (coupon/was-price evidence folded,
  // KWD-based), the same scale the effective-price line prints under the hero.
  const primaryCoupon = product.coupons[0];
  // REEA-787: the fold rides AFTER sortOffers — keep-first on the ranked,
  // stable order (live-first, in-stock-first, cheapest-effective) so the
  // surviving row of each twin group is the cheapest live answer, and the
  // retailer count + `from` figure below read the SAME folded set the rows
  // render (one honest count for what the shopper sees).
  const offers = foldRetailerRows(
    sortOffers(product.offers, primaryCoupon ?? null),
    primaryCoupon ?? null,
  );
  const best = offers[0];
  // REEA-847 — the flag slot's checking state, decided on the EXACT offer the
  // flag would sit on. While the Kuwait batch may still land, withhold the
  // unqualified "Best price" when no Kuwait-primary offer rendered at all
  // (REEA-835) OR the flagged offer is not a KWD price — counting a
  // Kuwait-primary merchant as "Kuwait answered" is not enough when its hits
  // are non-KWD (Jarir ships SAR), which is how the pill never fired on cold
  // queries whose first flush led with a Jarir SAR offer. The currency side
  // mirrors the price row's lead figure (REEA-283): the explicitly selected
  // market's currency wins, else the offer's native one.
  const kuwaitChecking =
    kuwaitBatchPending &&
    (kuwaitPendingStatus ||
      (best != null &&
        (country ? currencyForCountry(country) : best.currency).trim().toUpperCase() !== "KWD"));
  // Base figure for the swatch chips (REEA-254 + REEA-604): the cheapest
  // EFFECTIVE figure in KWD-space on this card — the same key the rows sort
  // on — so mixed-currency cards keep one unit on the chips. The server-side
  // priceDelta rides on top of it; the card's coupon shifts every chip by the
  // same evidence, it never reorders them.
  // REEA-963 FR-1.4 — the rollup reads NON-FLAGGED offers only; null when
  // every offer is flagged (E2: the card shows the warning state, never a
  // "from KD X" built from flagged prices).
  const cheapestListed = (() => {
    const priced = offers.filter((o) => !offerFlagged(o));
    return priced.length > 0
      ? Math.min(
          ...priced.map((o) =>
            effectivePriceKwd(o.price, o.currency, {
              wasPrice: o.wasPrice,
              couponDiscount: primaryCoupon?.discount,
            }),
          ),
        )
      : null;
  })();
  const oos = best != null && !best.inStock;
  // REEA-760 — coupon rows ride the CARD's own offer order (one key: the
  // sorted array the rows below render in), so the effective figure names the
  // retailer that actually leads this card.
  const couponRows = buildCouponRows(product.coupons, offers, country);

  // REEA-930 scope 2 — lead-card primary CTA. It rides the flagged best offer
  // (the SAME offer the Best-price flag sits on — one claim per card) and
  // only when that offer is actionable (in stock, resolvable REEA-13 href —
  // the exact gate the row buttons already use). Its figure is the card's ONE
  // effective-price arithmetic (effectivePriceKwd — the same key sortOffers
  // ranks on and the coupon line prints), rendered through the shared
  // country-led formatter chain (REEA-283 lead currency, REEA-896 KD unit
  // rule), NBSP-normalized like the coupon line's figure.
  const bestHref = best != null ? resolveOfferUrl(best, product.title) : null;
  // REEA-963 FR-1.4 — the lead CTA IS a best-price claim ("Best effective
  // price …"): a flagged lead offer can never carry it. The row's own
  // outbound buttons stay (the destination remains one tap away).
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
  // REEA-784/REEA-760 basis rule: the post-coupon figure may only print with
  // its basis named — say "with coupon" exactly when the coupon actually
  // lowered THIS offer's figure, never decoratively.
  //
  // REEA-947 AC2 — the delivered-discount restatement the first rule misses.
  // The REEA-603 coupon signal stamps the retailer's RUNNING discount
  // (compare-at above selling price) as an auto-applied coupon whose discount
  // string is the was→selling delta ("KD 40.10"). That discount is ALREADY
  // folded into the selling price, so the parseable-coupon comparison above
  // (leadEff < leadEffPlain) sees two equal figures and stays silent — while
  // the shopper-visible story is exactly "listed KD 400, coupon → KD 359.90"
  // (the REEA-943 QA case, measured live: lead offer Wibi 359.90 / wasPrice
  // 400, coupons[] led by an unparseable "KD 55" from another retailer, the
  // derived "KD 40.10" riding further down the array). When the LEAD offer
  // itself carries that compare-at and the card carries a coupon signal at
  // all, the printed figure is the post-coupon one — below the listed anchor,
  // with the coupon row's auto-applied chip backing the claim on the same
  // card — so the basis must be named. The figure arithmetic is untouched:
  // folding the delta string again would double-count the discount
  // (359.90 − 40.10), so the claim keys on the listed anchor, not on a second
  // application.
  const leadCompareAtCouponed =
    primaryCoupon != null && best != null && best.wasPrice != null && best.wasPrice > best.price;
  const leadCouponed =
    (primaryCoupon != null && leadEff != null && leadEffPlain != null && leadEff < leadEffPlain) ||
    leadCompareAtCouponed;
  const leadEffLabel =
    leadEff != null
      ? formatCountryPrice(leadEff, "KWD", country).primary.replace(/\u00A0/g, " ")
      : null;
  // REEA-930 scope 1 — the lead CTA's freshness line derives from the best
  // offer's own hop stamp against the baked render clock (hydration-stable;
  // LiveAge re-ticks client-side without a refetch).
  const leadAgeSecs = best != null ? ageSeconds(best.collectedAt, renderStartMs) : null;

  return (
    <article
      className={`result-card${oos ? " is-oos" : ""}${cascadeIndex != null ? " pulse-cascade" : ""}`}
      style={cascadeIndex != null ? ({ "--cascade-index": cascadeIndex } as React.CSSProperties) : undefined}
    >
      {/* REEA-65 §4.1: honest last-verified freshness, always visible on the
          feed-served results list (the detail view's freshness comes from the
          live job instead — realtime AC-1). */}
      <div className="flex flex-wrap items-center gap-2">
        {/* REEA-189 Rule 1 step 3: an unresolved brand renders NO brand line —
            an empty chip is itself an artifact. */}
        {product.brand ? <RetailerChip>{product.brand}</RetailerChip> : null}
        {!detail && best && <StockDot state={best.inStock ? "in" : "out"} locale={locale} />}
        {!detail && <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />}
        {/* REEA-541 Bet B: the one-tap share summary rides the header row of
            BOTH variants — the results card and the detail page's hero card —
            on the pill styling already shared with the selection chips. */}
        <ShareSummaryButton product={product} query={query} country={country} locale={locale} />
      </div>

      {/* REEA-75 (M4): flex-wrap lets the price drop under a long title on
          narrow viewports instead of squeezing the title to one word/line. */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {/* REEA-281 AC-1: photo(s) + title are ONE inline unit — the cluster
            keeps the card's two-child shape (title side / price side) so the
            existing wrap rules for long titles and narrow viewports hold. */}
        <div className="flex min-w-0 items-start gap-2">
          <ThumbRow product={product} />
          {/* Title links to the product page; underline on hover only (§3.3).
              REEA-836 AC3: the h2's native title attribute carries the FULL
              original retailer string on hover (≤1 interaction); the tap path
              is the disclosure below. */}
          <h2
            className="min-w-0"
            style={{ font: "var(--rc-text-title)", color: "var(--rc-ink)" }}
            title={titleChanged ? product.title : undefined}
          >
            {detail ? (
              displayTitle
            ) : (
              <Link
                href={`/product/${encodeURIComponent(product.productId)}`}
                className="hover:underline"
              >
                {displayTitle}
              </Link>
            )}
          </h2>
        </div>
        {/* Chrome-only detail (realtime AC-1): the price header renders on the
            feed-served results list; the product page's price comes solely
            from the live collection below. */}
        {!detail && best && (
          <PriceBlock
            offer={best}
            // REEA-963 FR-1.4 — a flagged lead offer never wears the
            // unqualified "Best price" flag (excluded from best-price claims).
            isBest={isBest && !oos && !offerFlagged(best)}
            hasCoupon={product.coupons.length > 0}
            oos={oos}
            country={country}
            locale={locale}
            kuwaitPending={kuwaitChecking}
          />
        )}
      </div>

      {/* REEA-930 scope 2/3 — the lead card's primary CTA, directly under
          the price it acts on (decision info above, action immediately after)
          so it stays as high as the card allows inside the ≤375px first
          viewport (AC5) — the REEA-760 coupon evidence lines remain below as
          attribution detail; the CTA already names the post-coupon basis.
          When it renders, the best row's own button stands down — ONE primary
          action per card (REEA-657's one-signal rule applied to the CTA),
          never two buttons to the same destination. */}
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

      {/* REEA-836 AC3 — transparency, not data loss: when the rendered title
          was cleaned, the retailer's FULL original string stays one tap away
          (native <details>: one click/tap, keyboard-accessible, no JS). One
          interaction on both pointer and touch; renders nothing on cards
          whose title needed no cleanup (AC6). */}
      {titleChanged && (
        <details className="mt-1">
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

      {/* REEA-760 coupon honesty line (spec eb16258c, ACCEPT REEA-748): one
          line per ISSUING retailer under the price cluster — chip carries the
          code verbatim or the exact one-step auto-note, attribution names the
          issuing retailer, ONE honest effective number prints per card on the
          leading retailer's row (existing effectivePrice arithmetic + headline
          formatter, bdi-isolated). No stacked amounts, no "+N more" — the
          secondary-count collapsed into the best-single-coupon pick inside
          buildCouponRows. State B: no coupons, no line, nothing reserved; the
          empty-slot caption below (REA-468 G3) is unchanged. */}
      {!detail && couponRows.map((row) => (
        <CouponLine key={`${row.merchant}-${row.coupon.code ?? ""}-${row.coupon.discount}`} row={row} locale={locale} />
      ))}

      {/* REEA-468 G3 — the coupon slot stays explicit when it is empty: a
          card whose live offers answer but carry no promo says "No coupon
          available" (t.couponNoneLabel), while a merchant that never
          answered is named by the coverage line ("No response from
          {merchant}"). The two states never read as each other. Same text-small
          muted treatment as the other chrome captions. */}
      {!primaryCoupon && offers.length > 0 && (
        <p className="mt-3" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {t.couponNoneLabel}
        </p>
      )}

      {/* REEA-65 §4.2: the card stays cheap — retailer count + lowest price
          only; the full per-retailer comparison lives on the detail view.
          REEA-721: the heading `from` figure is computed ONLY from this card's
          matching offers — the cheapest EFFECTIVE figure in KWD-space over the
          merged rows (cheapestListed, the same one key the rows sort on and
          the colour chips sit against) — so a mixed-currency card leads with
          a comparable KD figure instead of whichever raw numeric happened to
          answer first. Display runs through the shared KD formatter: at most
          TWO decimals, half-expand rounding (0.48861 → KD 0.49), whole figures
          bare, identical arithmetic in EN and AR. With a country selection
          formatCountryPrice still leads that market's currency (REEA-283) —
          the conversion is the same pair the offer rows print. */}
      {!detail && best && cheapestListed != null && (
        <p className="mt-3" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          <span className="tabular">{offers.length}</span>{" "}
          {offers.length === 1 ? t.retailersOne : t.retailersMany} · {t.fromWord}{" "}
          <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
            <bdi>{formatCountryPrice(cheapestListed, "KWD", country).primary}</bdi>
          </span>
        </p>
      )}
      {/* REEA-963 E2 — every offer on the card is sanity-flagged: the rollup
          slot renders the warning state, never a "from KD X" built from
          flagged prices. */}
      {!detail && best && cheapestListed == null && offers.length > 0 && (
        <p className="mt-3" style={{ font: "var(--rc-text-body)", color: "var(--rc-muted)" }}>
          <span className="price-warn" title={t.verifyOutlier}>
            <bdi>{t.priceVerifyBadge}</bdi>
          </span>
        </p>
      )}

      {/* REEA-540 Bet A — ONE confidence line per product card, results-list
          surfaces only (the detail view keeps its hierarchy). The figure is
          computed SERVER-side when the snapshot is built (lib/seen-range.ts)
          from the query's stored last-seen observations — no client fetch, no
          recompute. Fewer than 3 observation days leave the field unset and
          NOTHING renders here — never an interpolated guess. Same muted
          text-small caption treatment as the other chrome lines; figures ride
          through the existing country-led formatter. */}
      {!detail && product.seenRange != null && (
        <p className="mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {`${t.seenRecentlyLead} `}
          <span className="tabular"><bdi>{formatSeenRangeLabel(product.seenRange, country)}</bdi></span>
          {` · ${t.seenRecentlyWindow}`}
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
          aria-label={t.colourOptionsAria}
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
              {/* REEA-963 FR-3.3 — a variant family whose members are all
                  flagged renders the warning state, never a price. */}
              {v.needsVerification ? (
                <span className="price-warn" title={t.verifyOutlier}>
                  <bdi>{t.priceVerifyBadge}</bdi>
                </span>
              ) : (
                <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                  <bdi>{formatCountryPrice((cheapestListed ?? 0) + v.priceDelta, "KWD", country).primary}</bdi>
                </span>
              )}
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
        <section aria-label={t.pricesSectionAria} className="mt-4">
          <h3 className="label-token mb-1" style={{ color: "var(--rc-body-text)" }}>
            {t.pricesHeading}
          </h3>
          <ul>
            {offers.map((o, i) => {
              const href = resolveOfferUrl(o, product.title);
              // Neutrally labeled cheapest available offer — catalog price
              // only, no commission input (REEA-60 §7.1/§7.4).
              // REEA-963 FR-1.4 — a flagged offer is never the cheapest
              // highlight, however early it sorts.
              const isLowest = i === 0 && o.inStock && !offerFlagged(o);
              // REEA-283: country-led lead figure + muted converted stamp.
              const row = formatCountryPrice(o.price, o.currency, country);
              // REEA-963 — this row's own sanity verdict (FR-1.3 stays
              // visible with the warning affordance; E3 renders the honest
              // "price unavailable" state, never "KD 0").
              const rowReason = offerFlagged(o) ? o.sanity?.reason : undefined;
              const rowUnavailable = rowReason === "price_unavailable";
              // REEA-486 AC-2: the row's own hop stamp, aged against the same
              // baked render clock the freshness chip uses (hydration-stable).
              const age = relativeAge(o.collectedAt, renderStartMs);
              // REEA-510 — snapshot-filled rows state their ABSOLUTE
              // collection moment ("collected HH:MM") instead of a bare age:
              // the column was filled by this retailer+query's last live
              // answer, and the label says WHEN that happened. No usable
              // clock falls back to the plain age — never an empty qualifier.
              const clock = collectedClock(o.collectedAt);
              const stampLabel =
                o.fromSnapshot && clock != null ? `${t.collectedWord} ${clock}` : age;
              return (
                <li
                  key={`${o.merchant}-${o.url}`}
                  /* REEA-203: ONE row structure per breakpoint — below sm every
                     row stacks its label line above the right-aligned action
                     cluster; from sm up every row renders inline. REEA-848:
                     both clusters may wrap from sm up (between whole nowrap
                     tokens) — the old forced-nowrap clusters could not shrink
                     at 1280 and overflowed the card. */
                  className="offer-row flex flex-col justify-between gap-1 py-1 sm:flex-row sm:items-center sm:gap-x-2"
                  style={{ borderTop: "1px solid var(--rc-line)" }}
                >
                  {/* REEA-848 (supersedes REEA-224 item 1's nowrap contract):
                      merchant name and chips are ONE inline wrap unit — wrap
                      breaks only BETWEEN whole nowrap tokens, never inside
                      them. min-w-0 replaces the 160px floor so this cluster
                      yields width to the action cluster at 1280 instead of
                      squeezing it past the card border. */}
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
                      {/* REEA-451 F6 — bidi isolation around the Latin store name
                          so bidi reordering can't flip it inside Arabic chrome. */}
                      <bdi>{o.merchant}</bdi>
                    </span>
                    {/* REEA-486 AC-6: the merged card keeps each listing's own
                        qualifier visible — the label the retailer wrote
                        ("Japanese Version"), never folded away. Same chip
                        shape as the grade badge; long labels clip with an
                        ellipsis (title attr carries the full text). REEA-848:
                        36ch floor + shrink-0 so the chip ellipsizes only under
                        real pressure (28ch of the mono meta font clipped
                        "MIDDLE EAST VERSION" mid-word), and dir="auto" keeps
                        Latin variant strings ("MIDDLE EAST VERSION",
                        "JAPANESE") one unbroken LTR run inside the RTL row —
                        mixed-direction clipping was what produced "E EAST
                        VERSION" / "PANESE VERSION". */}
                    {o.label ? (
                      <span
                        dir="auto"
                        className="label-token inline-flex min-w-0 max-w-[36ch] shrink-0 items-center whitespace-nowrap overflow-hidden text-ellipsis rounded px-2 py-0.5"
                        title={o.label}
                        style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
                      >
                        {o.label}
                      </span>
                    ) : null}
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
                        className="label-token whitespace-nowrap shrink-0 rounded px-2 py-0.5"
                        style={{ background: "var(--rc-savings-bg)", color: "var(--rc-savings)" }}
                      >
                        {t.lowestListed}
                      </span>
                    )}
                  </span>
                  {/* REEA-848 (supersedes REEA-224 item 3 / REEA-646 nowrap
                      contract): the cluster wraps BETWEEN whole tokens from sm
                      up — forced nowrap could not shrink at 1280, painting the
                      stock dot over the LOWEST LISTED PRICE chip and the
                      button past the card border. gap-x-3 (12px) is the
                      minimum chip↔stock-dot gutter; gap-y-1 keeps wrapped
                      lines on the 4px baseline scale. min-w-0 keeps the
                      cluster shrinkable; items-center + justify-end hold the
                      wrapped shape against the row's inline end. */}
                  <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
                    <StockDot state={o.inStock ? "in" : "out"} locale={locale} />
                    {/* REEA-283: the row's figure leads in the selected country's
                        currency (the offer's native figure with no selection);
                        the converted stamp rides beside it on the same baseline
                        with column-gap 8px (gap-2). The font-weight:600 ink
                        treatment stays on the PRIMARY span only. */}
                    <span className="flex min-w-0 flex-wrap items-baseline justify-end gap-2 sm:flex-nowrap" style={{ font: "var(--rc-text-body)" }}>
                      {rowUnavailable ? (
                        <span className="price-cur tabular" style={{ color: "var(--rc-muted)" }}>
                          <bdi>{t.priceUnavailable}</bdi>
                        </span>
                      ) : (
                        <span className="price-cur tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                          <bdi>{row.primary}</bdi>
                        </span>
                      )}
                      {!rowUnavailable && row.alt && <span className="price-alt">· <bdi>{row.alt}</bdi></span>}
                      {/* REEA-963 FR-1.3 — flagged row keeps its figure and
                          gains the warning affordance (title carries why). */}
                      {rowReason && !rowUnavailable && (
                        <span className="price-warn" title={verifyTitleFor(rowReason, t)}>
                          <bdi>{t.priceVerifyBadge}</bdi>
                        </span>
                      )}
                      {/* REEA-486 AC-2: this row's own collected-at, aged —
                          muted like the converted stamp, so the figure keeps
                          the crown but every offer reads traceable to its
                          hop. REEA-510: snapshot rows print their absolute
                          collection clock instead (see stampLabel). */}
                      {stampLabel != null && <span className="price-alt">{stampLabel}</span>}
                    </span>
                    {/* REEA-13: render scraped hrefs only through validation;
                        REEA-116: direct retailer product URLs for every
                        adapter host; Bing search only when no URL captured
                        (resolveOfferUrl). REEA-930 scope 1: the row CTA is
                        freshness-anchored ("Checked 12s ago · Xcite") off the
                        offer's own hop stamp; no usable stamp falls back to
                        the plain label. REEA-930 scope 2: the flagged best
                        row stands its button down while the card's primary
                        CTA renders — one primary action per card. */}
                    {o.inStock && href && !(showLeadCta && i === 0) ? (
                      <TrackedOutboundLink
                        href={href}
                        query={query}
                        rank={rank}
                        itemId={product.productId}
                        queryId={queryId}
                        retailer={o.merchant}
                        className="btn-primary focusable min-h-9 shrink-0 px-3"
                      >
                        <OfferCtaLabel
                          merchant={o.merchant}
                          collectedAt={o.collectedAt}
                          initialSeconds={ageSeconds(o.collectedAt, renderStartMs)}
                          locale={locale}
                          fallback={t.goToStore}
                        />
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
        <section aria-label={t.variationsLabel} className="mt-4">
          <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
            {t.variationsLabel}
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
                    <bdi>{v.priceDelta > 0 ? "+" : "−"}
                    {formatKWD(Math.abs(v.priceDelta))}</bdi>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* §3.4 alternatives + REEA-592 pairs-with: 48px rows, right-aligned
          tabular price, hairline separators. REEA-488 item 1: the module
          rides BOTH variants now — the results card is where the homepage
          promise is cashed, and the server fills the rows from cheaper live
          groups. REEA-575 spec R1/R2: comparables ride the top row, capped
          complements the secondary one — identical row craft, so BOTH rows
          render from one loop. R4: an empty row renders NOTHING — never an
          empty shell, never a dangling heading. */}
      {(
        [
          [t.alternativesLabel, foldAlternativeRows(product.alternatives)],
          [t.pairsWithLabel, foldAlternativeRows(product.pairsWith ?? [])],
        ] as const
      ).map(
        ([label, rows]) =>
          rows.length === 0 ? null : (
                <section key={label} aria-label={label} className="mt-4">
                  <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
                    {label}
                  </h3>
                  <ul>
                    {/* REEA-75: wrap + min-h so long alt titles never push the
                        price past the card edge; price never shrinks. */}
                    {rows.map((a) => (
                      <li
                        key={a.productId}
                        className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded px-1 py-1 hover:bg-[var(--rc-canvas)]"
                      >
                        <a
                          href={buildResultsHref(a.title, 1, country, showOutOfStock)}
                          className="min-w-0 hover:underline"
                          style={{ font: "var(--rc-text-body)", fontWeight: 500, color: "var(--rc-ink)" }}
                          /* REEA-836 AC1: alternative rows are displayed listing
                              titles too — the same render-time cleanup applies;
                              the href still carries the RAW title so the next
                              query matches what the retailer indexed. */
                          title={displayTitleChanged(a.title, cleanDisplayTitle(a.title)) ? a.title : undefined}
                        >
                          {cleanDisplayTitle(a.title)}
                        </a>
                        <span
                          className="tabular ml-auto shrink-0"
                          style={{ font: "var(--rc-text-body)", fontWeight: 600, color: "var(--rc-ink)" }}
                        >
                          <><bdi>{`${t.fromWord} ${formatPrimaryPrice(a.fromPrice, "KWD").label}`}</bdi></>
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
