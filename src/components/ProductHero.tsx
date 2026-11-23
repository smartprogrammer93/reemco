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
import { filterOffersByCountry, type CountryCode } from "@/lib/country";
import { effectivePriceKwd, formatCountryPrice, formatPrimaryPrice } from "@/lib/format";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import CollectionPulse from "@/components/CollectionPulse";
import OfferStatusToken, { StatusLegend } from "@/components/OfferStatus";
import ShareSummaryButton from "@/components/ShareSummaryButton";
import { buildResultsHref } from "@/lib/country";
import { cleanDisplayTitle, displayTitleChanged } from "@/lib/display-title";
import { foldAlternativeRows } from "@/components/ProductResultCard";
import { ageSeconds, localizedAgeFor, localizedAgeFromStamp } from "@/lib/relative-time";
import { checkedAgeLabel, clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";
import { offerStatusForLiveOffer } from "@/lib/offer-status";
import type { NormalizedProduct } from "@/types/product";

function sortLiveOffers(offers: LiveOffer[]): LiveOffer[] {
  const key = (o: LiveOffer) => effectivePriceKwd(o.price, o.currency, { wasPrice: o.wasPrice });
  return [...offers].sort((a, b) => key(a) - key(b));
}

function ProductMedia({ product }: { product: NormalizedProduct }) {
  const src = product.image ?? product.offers.find((o) => o.image)?.image;
  return (
    <div className="rc-product-media">
      {src ? (
        <Image src={src} alt={`${cleanDisplayTitle(product.title)} — product image`} width={320} height={320} unoptimized />
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
}: {
  offer: LiveOffer;
  locale?: Locale;
  nowMs: number;
  primary: boolean;
}) {
  const t = getStrings(locale ?? clientLocale());
  const status = offerStatusForLiveOffer(offer, nowMs);
  const age = ageSeconds(offer.collectedAt, nowMs);
  const price = formatCountryPrice(offer.price, offer.currency, null);
  return (
    <div className={`rc-offer-row${offer.inStock ? "" : " is-out"}`}>
      <div className="rc-offer-line line-a">
        <span className="rc-retailer-name">
          <bdi className="logo lat">{offer.merchant}</bdi>
        </span>
        <span className={`rc-stock${offer.inStock ? "" : " is-out"}`}>
          <span className="dot" aria-hidden />
          {offer.inStock ? t.inStock : t.outOfStock}
        </span>
        <OfferStatusToken status={status} locale={locale} />
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
}: {
  offers: LiveOffer[];
  locale?: Locale;
  nowMs: number;
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
        <HeroOfferRow key={`${offer.merchant}-${offer.url}`} offer={offer} locale={locale} nowMs={nowMs} primary={i === 0} />
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
  firstStage?: Promise<CollectJob | null>;
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
  firstStage,
}: {
  product: NormalizedProduct;
  country?: CountryCode | null;
  locale?: Locale;
  firstStage?: Promise<CollectJob | null>;
}) {
  const t = getStrings(locale ?? clientLocale());
  const snap = firstStage ? use(firstStage) : null;
  const { state, cachedNoticeAt, start, retryRetailer, attach } = useCollection(product.productId, snap);
  const [staleFallback, setStaleFallback] = useState<CollectJob | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
  const offers = job ? filterOffersByCountry(sortLiveOffers(job.offers), country) : [];
  const best = offers[0] ?? null;
  const displayTitle = cleanDisplayTitle(product.title);
  const titleChanged = displayTitleChanged(product.title, displayTitle);
  const answered = job ? job.subtasks.filter((s) => s.status === "done").length : 0;
  const failedRetailers = job
    ? job.subtasks.filter((s) => s.status === "failed" || s.status === "timeout").map((s) => s.retailer)
    : [];
  const heroSaved = best && best.wasPrice != null && best.wasPrice > best.price ? best.wasPrice - best.price : null;
  const heroPrice = best ? formatCountryPrice(best.price, best.currency, null) : null;
  const coupon = product.coupons[0];

  return (
    <div className="mx-auto w-full rc-product-wrap" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)", paddingBlock: "var(--rc-space-4)" }}>
      <nav className="rc-results-meta" aria-label={t.allOffersLead}>
        <Link href={buildResultsHref(product.title, 1, country)}>{t.allOffersLead}</Link>
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
                <HeroOfferRow offer={best} locale={locale} nowMs={now} primary />
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
        <OfferTable offers={offers} locale={locale} nowMs={now} />
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
          <OfferTable offers={filterOffersByCountry(sortLiveOffers(staleFallback.offers), country)} locale={locale} nowMs={now} />
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
            {product.variations.map((v, i) => (
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
                <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                  <bdi>{formatPrimaryPrice(v.priceDelta, "KWD").label}</bdi>
                </span>
              </span>
            ))}
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
