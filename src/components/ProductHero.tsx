"use client";

/**
 * REEA-1069 — Direction A product hero + full-width offers table
 * (REEA-1055 §3 product anatomy, AC8/AC9). The identity (image, one h1) ships
 * in the server render; the price, savings, coupon and first offer render
 * ONLY from the live collection job this view starts, so one screen never
 * shows two contradicting freshness passes.
 *
 * Layout targets: image 320px desktop / 200px at 375, h1 28/22px, price 44px,
 * first offer inside the hero (y≈262 at 1280, y≈538 at 375 — both inside the
 * AC8 thresholds 400/600), offers table at 100% of the content width with the
 * single-line fixed-column anatomy at ≥641px and the two-line row at 375.
 * Accessories and cheaper alternatives sit BELOW the offers table.
 */

import { Suspense, useEffect, useState, use } from "react";
import Link from "next/link";
import Image from "next/image";
import { useCollection, type CollectionPhase } from "@/lib/collect/useCollection";
import type { CollectJob, LiveOffer } from "@/lib/collect/types";
import type { CountryCode } from "@/lib/country";
import {
  cheapestCrossMarketOffer,
  crossMarketHeadline,
  headlineOfferFor,
  isCrossMarketOffer,
  marketPriceLabel,
  marketScope,
  marketStockLabel,
  offerMarket,
  sortOffersByMarket,
} from "@/lib/market";
import { effectivePriceKwd, formatCountryPrice, formatPrimaryPrice } from "@/lib/format";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import CollectionPulse from "@/components/CollectionPulse";
import OfferStatusToken, { StatusLegend } from "@/components/OfferStatus";
import ShareSummaryButton from "@/components/ShareSummaryButton";
import { buildResultsHref } from "@/lib/country";
import { cleanDisplayTitle, displayTitleChanged } from "@/lib/display-title";
import { isProxiedImageSrc, proxiedImageSrc } from "@/lib/image-proxy";
import ProxyRetryImage from "@/components/ProxyRetryImage";
import { cheapestListedKwd, foldAlternativeRows } from "@/components/ProductResultCard";
import { ageSeconds, localizedAgeFor, localizedAgeFromStamp } from "@/lib/relative-time";
import { checkedAgeLabel, clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";
import { offerStatusForLiveOffer } from "@/lib/offer-status";
import type { NormalizedProduct } from "@/types/product";

/** REEA-1142 — market-scoped order: the selected market's offers lead, the
 *  cross-market ones follow as a labeled group (same ladder inside each). */
function sortLiveOffers(offers: LiveOffer[], scope: CountryCode): LiveOffer[] {
  return sortOffersByMarket(offers, null, scope);
}

function ProductMedia({ product }: { product: NormalizedProduct }) {
  // REEA-1128 — same proxied-source policy as the results card: a Shopify
  // product photo is fetched through our own origin, so the hero cannot show
  // a broken thumbnail (or log a console 403) when the retailer CDN refuses
  // the browser's hotlink fetch. A proxied source uses the retrying image so a
  // refusal wave does not leave the hero on the miss glyph.
  const src = proxiedImageSrc(product.image ?? product.offers.find((o) => o.image)?.image);
  const alt = `${cleanDisplayTitle(product.title)} — product image`;
  return (
    <div className="rc-product-media">
      {src ? (
        isProxiedImageSrc(src) ? (
          <ProxyRetryImage src={src} alt={alt} width={320} height={320} />
        ) : (
          <Image src={src} alt={alt} width={320} height={320} unoptimized referrerPolicy="no-referrer" />
        )
      ) : (
        <span className="rc-media-glyph" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} width={56} height={56}>
            <path d="M3 9.5 5.5 4h13L21 9.5V20H3V9.5Z" />
            <path d="M3 9.5h18M8.5 13.5h7" />
          </svg>
        </span>
      )}
    </div>
  );
}

function HeroOfferRow({
  offer,
  locale,
  nowMs,
  primary,
  scope,
}: {
  offer: LiveOffer;
  locale?: Locale;
  nowMs: number;
  primary: boolean;
  /** REEA-1142 — the market this surface speaks for. */
  scope: CountryCode;
}) {
  const t = getStrings(locale ?? clientLocale());
  const status = offerStatusForLiveOffer(offer, nowMs);
  const age = ageSeconds(offer.collectedAt, nowMs);
  // AC1 — a cross-market row keeps its own currency and carries the ≈KD
  // reference behind it, so a Saudi price never reads as a Kuwait price.
  const cross = isCrossMarketOffer(offer, scope);
  const market = offerMarket(offer.currency);
  const price = formatCountryPrice(offer.price, offer.currency, null);
  return (
    <div className={`rc-offer-row${offer.inStock ? "" : " is-out"}`}>
      <div className="rc-offer-line line-a">
        <span className="rc-retailer-name">
          <bdi className="logo lat">{offer.merchant}</bdi>
        </span>
        {cross && market ? (
          <span
            className="label-token shrink-0 whitespace-nowrap rounded px-2 py-0.5"
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
          >
            <bdi>{marketPriceLabel(market, locale)}</bdi>
          </span>
        ) : null}
        <span className={`rc-stock${offer.inStock ? "" : " is-out"}`}>
          <span className="dot" aria-hidden />
          {offer.inStock ? t.inStock : t.outOfStock}
        </span>
        {cross && market ? (
          <span
            className="label-token shrink-0 whitespace-nowrap rounded px-2 py-0.5"
            style={{ background: "var(--rc-canvas)", color: "var(--rc-body-text)", border: "1px solid var(--rc-line)" }}
          >
            <bdi>{marketStockLabel(market, locale)}</bdi>
          </span>
        ) : null}
        {/* REEA-963 — a flagged/cached cross-market row keeps its one
            verification token; only the unqualified "Verified" is replaced by
            the market badge above. */}
        {!cross || status !== "verified" ? (
          <OfferStatusToken status={status} locale={locale} />
        ) : null}
      </div>
      <div className="rc-offer-line line-b">
        {/* REEA-1096 D10 — the conversion stays inside the price block, and at
            375 the price + conversion + checked stamp share the card's proven
            two-line geometry, so a foreign-currency row is 93px like every
            other row (and 64px in the ≥641 single-line table). */}
        <span className="rc-price-block">
          <span className="price-cur rc-price-sm tabular" style={{ font: "var(--rc-text-price-sm)", fontWeight: 600, color: "var(--rc-ink)" }}>
            <bdi>{price.primary}</bdi>
          </span>
          <span className="rc-price-meta">
            {price.alt && (
              <span className="price-alt">
                <span className="price-alt-sep" aria-hidden>· </span>
                <bdi>{price.alt}</bdi>
              </span>
            )}
            <span className="rc-checked">{age == null ? t.dateUnknown : checkedAgeLabel(locale ?? clientLocale(), age)}</span>
          </span>
        </span>
        {offer.inStock ? (
          <TrackedOutboundLink
            href={offer.url}
            query=""
            rank={0}
            itemId={offer.merchant}
            retailer={offer.merchant}
            className={`${primary ? "btn-primary" : "btn-secondary"} focusable min-h-9 shrink-0 px-3 rc-offer-cta`}
          >
            {primary ? fill(t.offerGoTo, { x: offer.merchant }) : t.offerGo}
          </TrackedOutboundLink>
        ) : (
          <button type="button" className="btn-secondary rc-offer-cta" disabled>
            {t.offerGo}
          </button>
        )}
      </div>
    </div>
  );
}

function OfferTable({
  offers,
  locale,
  nowMs,
  scope,
}: {
  offers: LiveOffer[];
  locale?: Locale;
  nowMs: number;
  scope: CountryCode;
}) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="rc-offers-table">
      <h2>{fill(t.offersTableTitle, { n: offers.length })}</h2>
      {/* Spec §3: the status legend appears once on the product page too. It
          sits with the offers table (below the hero) so it never pushes the
          first offer past the AC8 y=600 ceiling at 375. */}
      <StatusLegend locale={locale} />
      <div className="rc-table-head" aria-hidden>
        <span>{t.tableRetailer}</span>
        <span>{t.tablePrice}</span>
        <span>{t.tableStock}</span>
        <span>{t.tableStatus}</span>
        <span>{t.tableChecked}</span>
        <span />
      </div>
      {offers.map((offer, i) => (
        <HeroOfferRow
          key={`${offer.merchant}-${offer.url}`}
          offer={offer}
          locale={locale}
          nowMs={nowMs}
          primary={i === 0}
          scope={scope}
        />
      ))}
    </div>
  );
}

function TableSkeleton({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="rc-offers-table" aria-busy="true" aria-label={t.offersTableAria}>
      <h2>{t.offersTableTitle.replace("{n}", "…")}</h2>
      {[0, 1, 2].map((i) => (
        <div className="rc-offer-row" key={i}>
          <div className="rc-offer-line line-a">
            <span className="rc-sk rc-sk-line" style={{ inlineSize: "30%" }} />
            <span className="rc-sk rc-sk-line" style={{ inlineSize: "20%" }} />
          </div>
          <div className="rc-offer-line line-b">
            <span className="rc-sk rc-sk-line" style={{ inlineSize: "25%" }} />
            <span className="rc-sk rc-sk-line" style={{ inlineSize: "30%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PanelFallback({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="rc-offers-table" aria-busy="true" aria-label={t.liveCollectionAria}>
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.startingLive}{" "}
        <button type="button" onClick={() => window.location.reload()} className="rc-inline-action hover:underline" style={{ color: "var(--rc-primary)" }}>
          {t.collectNow}
        </button>
      </p>
    </div>
  );
}

export default function ProductHero(props: {
  product: NormalizedProduct;
  country?: CountryCode | null;
  locale?: Locale;
  /** REEA-1140 — the results query this product was reached from, carried on
   *  the link so client-started collections resolve the same merged group. */
  query?: string;
  firstStage?: Promise<CollectJob | null>;
  /** REEA-283/REEA-1091 — the product page's baked server render clock. Every
   *  age / elapsed / status label on the first paint derives from it, so the
   *  served HTML and the hydration pass agree (no Date.now() recompute → no
   *  React #418); the live ticker only starts after mount. */
  renderStartMs?: number;
}) {
  return (
    <Suspense fallback={<PanelFallback locale={props.locale} />}>
      <ProductHeroBody {...props} />
    </Suspense>
  );
}

function ProductHeroBody({
  product,
  country = null,
  locale,
  query = "",
  firstStage,
  renderStartMs,
}: {
  product: NormalizedProduct;
  country?: CountryCode | null;
  locale?: Locale;
  query?: string;
  firstStage?: Promise<CollectJob | null>;
  renderStartMs?: number;
}) {
  const t = getStrings(locale ?? clientLocale());
  const snap = firstStage ? use(firstStage) : null;
  // REEA-1140 — a client restart (or 404 recovery) carries the results query
  // and market, so the server resolves the same merged group the page did.
  const { state, cachedNoticeAt, start, retryRetailer, attach } = useCollection(
    product.productId,
    snap,
    query,
    country,
  );
  const [staleFallback, setStaleFallback] = useState<CollectJob | null>(null);
  // REEA-283/REEA-1091 — the FIRST paint reuses the page's baked render clock
  // instead of a fresh Date.now(), so the streamed hero/offer ages, status
  // tokens and elapsed label are identical in the served HTML and the
  // hydration pass. The interval takes over with the real clock after mount.
  const [now, setNow] = useState(() => renderStartMs ?? Date.now());
  const phase = state as CollectionPhase;
  const collecting = phase.kind === "polling";
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [collecting]);

  useEffect(() => {
    if (snap) attach(snap);
    else void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.productId]);

  useEffect(() => {
    const job = phase.kind === "terminal" ? phase.job : null;
    const previousId = job?.status === "failed" ? job.previousJobId : undefined;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      if (!previousId) {
        setStaleFallback(null);
        return;
      }
      try {
        const res = await fetch(`/api/collect-jobs/${previousId}`, { cache: "no-store" });
        if (res.ok && !cancelled) setStaleFallback((await res.json()) as CollectJob);
      } catch {
        /* error state stands */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- phase derives from state; the effect re-runs on every poll snapshot.
  }, [state]);

  const job = phase.kind === "polling" || phase.kind === "terminal" ? phase.job : null;
  // REEA-1142 AC2 — the product hero's headline is the selected market's
  // cheapest in-stock offer; a cross-market-only product shows the honest
  // "No Kuwait offer · Saudi price from KD X" line instead of claiming one.
  const scope = marketScope(country);
  const offers = job ? sortLiveOffers(job.offers, scope) : [];
  const localBest = headlineOfferFor(offers, scope);
  const crossBest = cheapestCrossMarketOffer(offers, scope);
  const best = localBest ?? crossBest ?? offers[0] ?? null;
  const hasLocalOffer = localBest !== null;
  const headline = hasLocalOffer ? null : crossMarketHeadline(offers, scope, locale);
  const displayTitle = cleanDisplayTitle(product.title);
  const titleChanged = displayTitleChanged(product.title, displayTitle);
  const answered = job ? job.subtasks.filter((s) => s.status === "done").length : 0;
  const failedRetailers = job
    ? job.subtasks.filter((s) => s.status === "failed" || s.status === "timeout").map((s) => s.retailer)
    : [];
  const heroSaved = best && best.wasPrice != null && best.wasPrice > best.price ? best.wasPrice - best.price : null;
  const heroPrice = best
    ? formatCountryPrice(best.price, best.currency, hasLocalOffer ? country : null)
    : null;
  const coupon = product.coupons[0];
  // REEA-1122 — the variant chips ride the SAME price pass as the hero: the
  // cheapest live offer's KWD-space figure. That keeps the selected chip equal
  // to the hero price the shopper reads on this screen (never a chip from a
  // different freshness pass). Before any live offer lands, fall back to the
  // identity record's cheapest listed offer, so the chip still carries a real
  // figure instead of the old raw delta ("Orange KD 0").
  const liveBestKwd = best
    ? effectivePriceKwd(best.price, best.currency, { wasPrice: best.wasPrice })
    : null;
  const variantBaseKwd = liveBestKwd ?? cheapestListedKwd(product, scope);

  return (
    <div className="mx-auto w-full rc-product-wrap" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)", paddingBlock: "var(--rc-space-4)" }}>
      <nav className="rc-results-meta" aria-label={t.allOffersLead}>
        {/* REEA-1140 — the back link returns to the query the shopper came
            from when it is carried; a shared-link visit keeps the title. */}
        <Link href={buildResultsHref(query || product.title, 1, country)}>{t.allOffersLead}</Link>
      </nav>
      <div className="rc-product-hero">
        <ProductMedia product={product} />
        <div>
          <div className="rc-product-share flex flex-wrap items-center gap-2">
            <ShareSummaryButton product={product} country={country} locale={locale} />
          </div>
          <h1 style={{ marginBlockStart: "var(--rc-space-2)" }}>
            <bdi className="lat">{displayTitle}</bdi>
          </h1>
          {titleChanged && (
            <details style={{ marginBlockStart: 4 }}>
              <summary className="label-token cursor-pointer" style={{ color: "var(--rc-muted)" }}>
                {t.originalTitleLabel}
              </summary>
              <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>{product.title}</p>
            </details>
          )}
          {best && heroPrice ? (
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
              <div className="rc-product-best">
                <span className="rc-product-price tabular price-cur">
                  {(locale ?? "en") === "ar" ? <span className="price-from">{t.fromWord} </span> : null}
                  <bdi>{heroPrice.primary}</bdi>
                </span>
                {heroPrice.alt && <span className="price-alt">· <bdi>{heroPrice.alt}</bdi></span>}
                {best.wasPrice != null && best.wasPrice > best.price && (
                  <span className="rc-price-was tabular">
                    <bdi>{formatCountryPrice(best.wasPrice, best.currency, null).primary}</bdi>
                  </span>
                )}
                {heroSaved != null && (
                  <span className="rc-savings">
                    <bdi>{`${t.saveLead} ${formatCountryPrice(heroSaved, best.currency, null).primary}`}</bdi>
                  </span>
                )}
              </div>
              {heroSaved != null && (
                <p className="rc-product-basis">{fill(t.savingsBaseline, { x: best.merchant })}</p>
              )}
              {coupon && (
                <p className="rc-product-coupon">
                  {fill(t.couponApplied, { x: coupon.discount })}
                </p>
              )}
              <div className="rc-hero-offer">
                <HeroOfferRow offer={best} locale={locale} nowMs={now} primary scope={scope} />
              </div>
              <p className="rc-product-meta">
                {fill(answered === 1 ? t.productCollectedOne : t.productCollected, {
                  age:
                    best.collectedAtEpochMs != null
                      ? localizedAgeFor(locale ?? "en", best.collectedAtEpochMs, now)
                      : (() => {
                          const secs = ageSeconds(best.collectedAt, now);
                          return secs == null ? t.dateUnknown : checkedAgeLabel(locale ?? "en", secs);
                        })(),
                  n: answered,
                })}
              </p>
            </>
          ) : phase.kind === "terminal" && job?.status === "failed" ? (
            <div className="rc-error-state" role="alert" style={{ marginBlockStart: "var(--rc-space-4)" }}>
              <svg className="icon" width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6M12 17h.01" />
              </svg>
              <h2>{t.errorRetailersTitle}</h2>
              <p>{t.errorRetailersBody}</p>
              <button type="button" onClick={() => void start({ force: true })} className="btn-primary focusable min-h-11 px-4">
                {t.tryAgain}
              </button>
            </div>
          ) : (
            <div className="rc-skeleton" style={{ marginBlockStart: "var(--rc-space-4)" }} aria-busy="true">
              <div className="rc-sk rc-sk-line short" />
              <div className="rc-sk rc-sk-fill rc-sk-price" />
              <div className="rc-sk rc-sk-line" />
              <div className="rc-sk rc-sk-line" style={{ blockSize: 44 }} />
            </div>
          )}
        </div>
      </div>

      {failedRetailers.length > 0 && offers.length > 0 ? (
        <div className="rc-partial" role="status">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 7.8h.01" />
          </svg>
          <p>
            {fill(t.productRetailersAnswered, { n: answered })}{" "}
            {failedRetailers.map((name, i) => (
              <span key={name}>
                <bdi className="lat">{name}</bdi>
                {i < failedRetailers.length - 1 ? "، " : ""}
              </span>
            ))}
          </p>
        </div>
      ) : null}

      {job && job.status === "collecting" && (
        <CollectionPulse
          job={job}
          elapsedLabel={`${Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000))}s`}
          onRetryRetailer={(retailer) => void retryRetailer(retailer, job.jobId)}
          locale={locale}
        />
      )}

      {offers.length > 0 ? (
        <OfferTable offers={offers} locale={locale} nowMs={now} scope={scope} />
      ) : phase.kind === "polling" || phase.kind === "starting" || phase.kind === "idle" ? (
        <TableSkeleton locale={locale} />
      ) : job?.status === "failed" && staleFallback && staleFallback.offers.length > 0 ? (
        <div className="rc-offers-table">
          <p className="rc-results-meta">
            {t.showingCachedLead}{" "}
            {localizedAgeFromStamp(locale ?? "en", staleFallback.finishedAt ?? staleFallback.startedAt, now) ??
              t.dateUnknown}{" "}
            {t.staleNote}
          </p>
          <OfferTable offers={sortLiveOffers(staleFallback.offers, scope)} locale={locale} nowMs={now} scope={scope} />
        </div>
      ) : null}

      {job && job.status === "complete" && !cachedNoticeAt && (
        <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", marginBlockStart: 8 }}>
          {t.liveResultsLead}{" "}
          {localizedAgeFromStamp(locale ?? "en", job.finishedAt ?? job.startedAt, now) ?? t.dateUnknown} ·{" "}
          <button type="button" onClick={() => void start({ force: true })} className="rc-inline-action hover:underline" style={{ color: "var(--rc-primary)" }}>
            {t.collectAgain}
          </button>
        </p>
      )}
      {cachedNoticeAt && (
        <p style={{ marginBlockStart: 8 }}>
          <span className="cached-chip">
            {t.cachedLead} {new Date(cachedNoticeAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
        </p>
      )}

      {product.variations.length > 0 && (
        <section aria-label={t.variationsLabel} style={{ marginBlockStart: "var(--rc-space-6)" }}>
          <h2 style={{ font: "var(--rc-text-h2)" }}>{t.variationsLabel}</h2>
          <div className="rc-variants" style={{ marginBlockStart: "var(--rc-space-3)" }}>
            {product.variations.map((v, i) => {
              // REEA-1122 — the results card prints the variant's ABSOLUTE
              // price (base + delta); the hero used to print the raw delta, so
              // the cheapest variant read "Orange KD 0" beside a paid product.
              // Same convention here: name + absolute KWD figure. No base →
              // name only, never an invented number.
              const chipPrice =
                variantBaseKwd != null
                  ? formatCountryPrice(variantBaseKwd + v.priceDelta, "KWD", country).primary
                  : null;
              return (
                <span
                  key={v.id}
                  className={`rc-variant${i === 0 ? " is-selected" : ""}`}
                  aria-pressed={i === 0 ? "true" : "false"}
                >
                  {i === 0 ? (
                    <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m4 12.5 5 5L20 6.5" />
                    </svg>
                  ) : null}
                  {v.label}
                  {/* REEA-1096 D2/D3 — selected state keyed on aria-pressed; the
                      chip is name + price, never a verification status token. */}
                  {chipPrice ? (
                    <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                      <bdi>{chipPrice}</bdi>
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {(
        [
          [t.alternativesLabel, foldAlternativeRows(product.alternatives)],
          [t.pairsWithLabel, foldAlternativeRows(product.pairsWith ?? [])],
        ] as const
      ).map(([label, rows]) =>
        rows.length === 0 ? null : (
          <section key={label} aria-label={label} style={{ marginBlockStart: "var(--rc-space-6)" }}>
            <h2 style={{ font: "var(--rc-text-h2)" }}>{label}</h2>
            <div className="rc-alt-grid">
              {rows.map((a) => (
                <article className="rc-alt" key={a.productId}>
                  <Link href={buildResultsHref(a.title, 1, country)} className="name">
                    <bdi>{cleanDisplayTitle(a.title)}</bdi>
                  </Link>
                  <div className="price tabular">
                    <bdi>{`${t.fromWord} ${formatPrimaryPrice(a.fromPrice, "KWD").label}`}</bdi>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
