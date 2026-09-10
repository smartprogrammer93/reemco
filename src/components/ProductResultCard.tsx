import Link from "next/link";
import Image from "next/image";
import type { Coupon, NormalizedProduct, PriceOffer } from "@/types/product";
import { buildResultsHref, type CountryCode } from "@/lib/country";
import { effectivePrice, formatCountryPrice, formatKdDigits, formatPrimaryPrice, sortOffers, toKwdNumeric } from "@/lib/format";
import { gradeBadgeLabel } from "@/lib/collect/canonical-product";
import { relativeAge } from "@/lib/relative-time";
import CouponBadge from "@/components/CouponBadge";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import { resolveOfferUrl } from "@/lib/links";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";
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
  coupon,
  oos = false,
  country,
  locale,
}: {
  offer: PriceOffer;
  isBest: boolean;
  coupon?: Coupon;
  oos?: boolean;
  country: CountryCode | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const eff = effectivePrice(offer, coupon);
  // REEA-75: ml-auto keeps the price right-aligned when the row wraps;
  // flex-wrap on the baseline row stops the Best badge clipping (M3).
  const saved = offer.wasPrice != null && offer.wasPrice > offer.price;
  // REEA-283: the selected country's currency LEADS the price rows (SA→SAR,
  // KW→KWD, EG→EGP); with no selection the offer's native figure leads. The
  // converted side rides behind as the muted `.price-alt` stamp — REEA-195's
  // "nothing silently rewritten" rule, now in the shopper's market order.
  const hero = formatCountryPrice(offer.price, offer.currency, country);
  return (
    // REEA-95 step-5 mobile pass: at narrow widths the price block takes the
    // full row so its chips wrap inside the viewport instead of forcing the
    // card wider than the screen (sm: restores side-by-side with the title).
    <div className="ml-auto w-full shrink-0 text-right sm:w-auto">
      <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
        <span
          className="price-cur tabular"
          style={{
            font: "var(--rc-text-price)",
            color: isBest ? "var(--rc-savings)" : "var(--rc-ink)",
            textDecoration: oos ? "line-through" : undefined,
          }}
        >
          {hero.primary}
        </span>
        {hero.alt && <span className="price-alt">{`· ${hero.alt}`}</span>}
        {/* §5.3: strikethrough compare-at BESIDE the price, savings pill right
            after it — savings emphasis without stealing the price's crown.
            REEA-283: single-figure lines follow the LEAD currency too, so one
            card never mixes two currency orders. */}
        {saved && offer.wasPrice != null && (
          <span
            className="tabular"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", textDecoration: "line-through" }}
          >
            {formatCountryPrice(offer.wasPrice, offer.currency, country).primary}
          </span>
        )}
        {saved && offer.wasPrice != null && (
          <span className="savings-pill">{`${t.saveLead} ${formatCountryPrice(offer.wasPrice - offer.price, offer.currency, country).primary}`}</span>
        )}
        {isBest && <span className="best-flag">{t.bestPrice}</span>}
      </div>
      {/* Effective-price line: computed value, always explained (§3.3) */}
      {eff != null && (
        <p className="mt-1" style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}>
          {t.effectiveLead}{" "}
          <span className="tabular" style={{ color: "var(--rc-savings)" }}>
            {formatCountryPrice(eff, offer.currency, country).primary}
          </span>{" "}
          {t.effectiveTail} {coupon?.code ?? coupon?.discount}
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
  renderStartMs,
  locale,
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
  /** REEA-283 server-render clock for the freshness chip (hydration-reused). */
  renderStartMs?: number;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const detail = variant === "detail";
  const t = getStrings(locale ?? clientLocale());
  const offers = sortOffers(product.offers);
  const best = offers[0];
  // Base figure for the swatch chips (REEA-254): the cheapest listed price in
  // KWD-space — the same base the server used for each swatch's priceDelta
  // (toKwdNumeric), so mixed-currency cards keep one unit on the chips.
  const cheapestListed =
    offers.length > 0 ? Math.min(...offers.map((o) => toKwdNumeric(o.price, o.currency))) : 0;
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
        {!detail && best && <StockDot state={best.inStock ? "in" : "out"} locale={locale} />}
        {!detail && <FreshnessBadge scrapedAt={product.scrapedAt} renderStartMs={renderStartMs} locale={locale} />}
      </div>

      {/* REEA-75 (M4): flex-wrap lets the price drop under a long title on
          narrow viewports instead of squeezing the title to one word/line. */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {/* REEA-281 AC-1: photo(s) + title are ONE inline unit — the cluster
            keeps the card's two-child shape (title side / price side) so the
            existing wrap rules for long titles and narrow viewports hold. */}
        <div className="flex min-w-0 items-start gap-2">
          <ThumbRow product={product} />
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
        </div>
        {/* Chrome-only detail (realtime AC-1): the price header renders on the
            feed-served results list; the product page's price comes solely
            from the live collection below. */}
        {!detail && best && (
          <PriceBlock
            offer={best}
            isBest={isBest && !oos}
            coupon={primaryCoupon}
            oos={oos}
            country={country}
            locale={locale}
          />
        )}
      </div>

      {/* Coupon pill (§5.4): amber, value only; extras count beside it */}
      {primaryCoupon && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CouponBadge coupon={primaryCoupon} locale={locale} />
          {extraCoupons > 0 && (
            <span
              title={product.coupons
                .slice(1)
                .map((c) => c.code)
                .filter(Boolean)
                .join(", ")}
              style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}
            >
              {`+${extraCoupons} ${t.couponMoreSuffix}`}
            </span>
          )}
        </div>
      )}

      {/* REEA-65 §4.2: the card stays cheap — retailer count + lowest price
          only; the full per-retailer comparison lives on the detail view. */}
      {!detail && best && (
        <p className="mt-3" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          <span className="tabular">{offers.length}</span>{" "}
          {offers.length === 1 ? t.retailersOne : t.retailersMany} · {t.fromWord}{" "}
          <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
            {formatCountryPrice(best.price, best.currency, country).primary}
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
              <span className="tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                {formatCountryPrice(cheapestListed + v.priceDelta, "KWD", country).primary}
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
        <section aria-label={t.pricesSectionAria} className="mt-4">
          <h3 className="label-token mb-1" style={{ color: "var(--rc-body-text)" }}>
            {t.pricesHeading}
          </h3>
          <ul>
            {offers.map((o, i) => {
              const href = resolveOfferUrl(o, product.title);
              // Neutrally labeled cheapest available offer — catalog price
              // only, no commission input (REEA-60 §7.1/§7.4).
              const isLowest = i === 0 && o.inStock;
              // REEA-283: country-led lead figure + muted converted stamp.
              const row = formatCountryPrice(o.price, o.currency, country);
              // REEA-486 AC-2: the row's own hop stamp, aged against the same
              // baked render clock the freshness chip uses (hydration-stable).
              const age = relativeAge(o.collectedAt, renderStartMs);
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
                  className="offer-row flex flex-col justify-between gap-1 py-1 sm:flex-row sm:items-center sm:gap-x-2"
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
                    {/* REEA-486 AC-6: the merged card keeps each listing's own
                        qualifier visible — the label the retailer wrote
                        ("Japanese Version"), never folded away. Same chip
                        shape as the grade badge; long labels clip with an
                        ellipsis (title attr carries the full text). */}
                    {o.label ? (
                      <span
                        className="label-token inline-flex min-w-0 max-w-[28ch] items-center whitespace-nowrap overflow-hidden text-ellipsis rounded px-2 py-0.5"
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
                        className="label-token whitespace-nowrap rounded px-2 py-0.5"
                        style={{ background: "var(--rc-savings-bg)", color: "var(--rc-savings)" }}
                      >
                        {t.lowestListed}
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
                    <StockDot state={o.inStock ? "in" : "out"} locale={locale} />
                    {/* REEA-283: the row's figure leads in the selected country's
                        currency (the offer's native figure with no selection);
                        the converted stamp rides beside it on the same baseline
                        with column-gap 8px (gap-2). The font-weight:600 ink
                        treatment stays on the PRIMARY span only. */}
                    <span className="flex min-w-0 items-baseline gap-2" style={{ font: "var(--rc-text-body)" }}>
                      <span className="price-cur tabular" style={{ fontWeight: 600, color: "var(--rc-ink)" }}>
                        {row.primary}
                      </span>
                      {row.alt && <span className="price-alt">{`· ${row.alt}`}</span>}
                      {/* REEA-486 AC-2: this row's own collected-at, aged —
                          muted like the converted stamp, so the figure keeps
                          the crown but every offer reads traceable to its
                          hop. */}
                      {age != null && <span className="price-alt">{age}</span>}
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
                        {t.goToStore}
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
                    {v.priceDelta > 0 ? "+" : "−"}
                    {formatKdDigits(Math.abs(v.priceDelta), 2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* §3.4 alternatives: 48px rows, right-aligned tabular price, hairline
          separators. REEA-488 item 1: the module rides BOTH variants now —
          the results card is where the homepage promise is cashed, and the
          server fills the list from cheaper same-family collected groups. An
          empty list still renders NOTHING — never an empty shell. */}
      {product.alternatives.length > 0 && (
        <section aria-label={t.alternativesLabel} className="mt-4">
          <h3 className="label-token mb-2" style={{ color: "var(--rc-body-text)" }}>
            {t.alternativesLabel}
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
                  {`${t.fromWord} ${formatPrimaryPrice(a.fromPrice, "KWD").label}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
