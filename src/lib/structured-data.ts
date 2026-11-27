/**
 * REEA-1168 / REEA-1212 — Product/Offer structured data for the live results
 * surface.
 *
 * REEA-1212 defect: the module used to read the raw `product.offers` through
 * its own freshness/snapshot filter, while the shelf card painted a different
 * chain (market selection, real-coupon composition, retailer-row fold, 3-row
 * anatomy, headline offer). On `/results?q=iphone 17 pro` that omitted the
 * card's visible best offer (Wibi, coupon-effective KD 314.90) from the
 * JSON-LD and advertised KD 319.90 instead — a rich result that contradicted
 * the page it annotates (REEA-1168 AC-3).
 *
 * The fix: every emitted Offer is projected through `visibleShelfOffers`
 * (lib/results-offers.ts), the SAME pure projection the results card renders,
 * over the SAME painted card set the streamed page actually shows. The
 * description's "starting at" figure is the card's visible best price
 * (headline offer), never a second definition. No bundled catalogue, no
 * second fetch, no client work — the script tag is rendered by a server
 * component (components/ResultsStructuredData.tsx).
 */
import type { LiveOffer } from "@/lib/collect/types";
import type { CountryCode } from "@/lib/country";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import { proxiedImageSrc } from "@/lib/image-proxy";
import { OFFER_STATUS_STALE_MS } from "@/lib/offer-status";
import { compositionOfOffer } from "@/lib/price-composition";
import { catalogProductIdFor } from "@/lib/product-canonical";
import { resultsShelfCards } from "@/lib/results-shelf";
import { visibleShelfOffers } from "@/lib/results-offers";
import { countryLabel } from "@/lib/results-meta";
import { safeHref } from "@/lib/safe-url";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

export const SCHEMA_ORG = "https://schema.org";

/** The site's offer freshness window: the same 24 h threshold the visible
 *  status system uses to label an offer "Stale". When an observation stamp is
 *  available, `priceValidUntil` is derived from it plus this window, so a
 *  structured-data price carries the same freshness claim the page makes. */
export const STRUCTURED_DATA_FRESHNESS_MS = OFFER_STATUS_STALE_MS;

export interface ProductJsonLd {
  "@context": typeof SCHEMA_ORG;
  "@type": "Product";
  name: string;
  description: string;
  sku: string;
  url: string;
  brand?: { "@type": "Brand"; name: string };
  image?: string[];
  offers: OfferJsonLd[];
}

export interface OfferJsonLd {
  "@type": "Offer";
  url: string;
  /** The price the card's composition line prints as "You pay" (effective
   *  after the offer's own was-price/coupon evidence), in native currency. */
  price: number;
  priceCurrency: string;
  availability: string;
  seller: { "@type": "Organization"; name: string };
  /** The observation timestamp for THIS offer (retailer hop / collection),
   *  omitted when the record carries no usable stamp. */
  validFrom?: string;
  /** Observation stamp + the site freshness window, when known. */
  priceValidUntil?: string;
}

export interface StructuredDataSnapshot {
  products: readonly NormalizedProduct[];
  collectedAt?: string;
  collectedAtEpochMs?: number;
}

export interface BuildStructuredDataArgs {
  /**
   * REEA-1212 — the exact painted card set the shopper sees. The results
   * page passes the output of the renderer's own paint chain
   * (lib/results-shelf.ts `paintedShelfCardsAcrossStages`), so the structured
   * data can never describe a different slice.
   */
  cards?: readonly NormalizedProduct[];
  /** Legacy/test path: derive the shelf cards from this snapshot when
   *  `cards` is absent. */
  snapshot?: StructuredDataSnapshot;
  query: string;
  country: CountryCode | null;
  locale: Locale;
  /** One baked server render clock, same value threaded through the page. */
  nowMs: number;
  /** Absolute serving origin (lib/site-origin.ts). */
  origin: string;
  page?: number;
  showOutOfStock?: boolean;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteMs(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The observation stamp for one offer, in priority order: the offer's own
 *  hop stamp, the product's collection stamp, then the snapshot's collection
 *  stamp. Returns null when the record carries no usable timestamp — the
 *  Offer is still emitted (it is visible on the page), but without a
 *  validity window. */
function observationMs(
  offer: PriceOffer,
  product: NormalizedProduct,
  snapshot: StructuredDataSnapshot | undefined,
): number | null {
  return (
    finiteMs(offer.collectedAtEpochMs) ??
    parseMs(offer.collectedAt) ??
    finiteMs(product.scrapedAtEpochMs) ??
    parseMs(product.scrapedAt) ??
    finiteMs(snapshot?.collectedAtEpochMs) ??
    parseMs(snapshot?.collectedAt)
  );
}

function currencyDecimals(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (code === "KWD" || code === "BHD" || code === "OMR" || code === "JOD") return 3;
  if (code === "JPY" || code === "KRW") return 0;
  return 2;
}

function roundPrice(price: number, currency: string): number {
  return Number(price.toFixed(currencyDecimals(currency)));
}

/** ISO date-only form (schema.org Date) for priceValidUntil. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function absoluteImage(image: string | undefined, origin: string): string | undefined {
  const proxied = proxiedImageSrc(image);
  if (!proxied) return undefined;
  if (/^https?:\/\//i.test(proxied)) return safeHref(proxied) ?? undefined;
  if (proxied.startsWith("/")) return `${origin.replace(/\/$/, "")}${proxied}`;
  return undefined;
}

function productPageUrl(origin: string, productId: string): string {
  return `${origin.replace(/\/$/, "")}/product/${encodeURIComponent(productId)}`;
}

/**
 * The figure the card prints as "You pay" for one offer: the effective price
 * from the offer's served composition (or the composition derived from its
 * own was-price evidence), falling back to the listed figure when the
 * discount's applied value is conditional/unknown. This is exactly what the
 * card's headline and composition line use — never a second subtraction.
 */
function payableNativePrice(offer: PriceOffer): number | null {
  const composition = compositionOfOffer(offer);
  const figure = composition.effective ?? composition.listed;
  if (!Number.isFinite(figure)) return Number.isFinite(offer.price) ? Math.max(0, offer.price) : null;
  return Math.max(0, figure);
}

/**
 * Build one Product node per painted shelf card. The Offer set is the card's
 * visible offer set (the same projection the card paints), including the
 * card's headline offer even when it sits behind the 3-row "view all" cap.
 * The description's "starting at" figure is the card's visible best price.
 * Returns [] when nothing is visible.
 */
export function buildResultsStructuredData(args: BuildStructuredDataArgs): ProductJsonLd[] {
  const { query, country, locale, origin } = args;
  const cards =
    args.cards ??
    (args.snapshot
      ? resultsShelfCards(
          args.snapshot,
          query,
          args.page ?? 1,
          country,
          args.showOutOfStock ?? false,
        )
      : []);
  const t = getStrings(locale);
  const market = countryLabel(country, locale);
  const nodes: ProductJsonLd[] = [];

  for (const product of cards) {
    // REEA-1212 — the ONE visible-offer projection: market scoping, real
    // coupons, fold, ordering, headline and row cap. The card uses this same
    // function, so JSON-LD and the page can never fork again.
    // REEA-1238 — read `cardRows`, the exact row set the card paints (one row
    // per retailer on a comparison card), not the pre-cap slice.
    const { cardRows: rows, best } = visibleShelfOffers(product, country);
    if (rows.length === 0 || best === null) continue;

    // The headline offer is visible on the page (it is the price the card
    // leads with) even when its row sits beyond the 3-row anatomy cap. Emit
    // it alongside the painted rows so "no visible best offer may be absent
    // from JSON-LD" holds without inventing an offer.
    const visibleOffers = rows.includes(best) ? rows : [...rows, best];

    const bestPrice = payableNativePrice(best);
    const bestCurrency = best.currency?.trim().toUpperCase();
    if (bestPrice === null || !bestCurrency) continue;

    const title = product.title?.trim() || query.trim() || product.productId;
    // REEA-1189 — point at the same canonical URL the sitemap lists when the
    // live SKU is the catalog seed's own identity. Live-only SKUs keep their
    // merge slug; a catalog-covered product must not advertise a second URL.
    const canonicalId = catalogProductIdFor(product) ?? product.productId;
    const url = productPageUrl(origin, canonicalId);

    const offers: OfferJsonLd[] = [];
    for (const offer of visibleOffers) {
      const currency = offer.currency?.trim().toUpperCase();
      const price = payableNativePrice(offer);
      if (!currency || price === null) continue;
      const observedAtMs = observationMs(offer, product, args.snapshot);
      offers.push({
        "@type": "Offer",
        url: safeHref(offer.url) ?? url,
        price: roundPrice(price, currency),
        priceCurrency: currency,
        availability: offer.inStock
          ? `${SCHEMA_ORG}/InStock`
          : `${SCHEMA_ORG}/OutOfStock`,
        seller: { "@type": "Organization", name: offer.merchant },
        ...(observedAtMs !== null
          ? {
              validFrom: new Date(observedAtMs).toISOString(),
              priceValidUntil: isoDate(observedAtMs + STRUCTURED_DATA_FRESHNESS_MS),
            }
          : {}),
      });
    }
    if (offers.length === 0) continue;

    const image = absoluteImage(
      product.image ?? product.offers.find((offer) => offer.image)?.image,
      origin,
    );
    const brand = product.brand?.trim();

    nodes.push({
      "@context": SCHEMA_ORG,
      "@type": "Product",
      name: fill(t.jsonLdProductName, { title, country: market }),
      description: fill(t.jsonLdProductDescription, {
        title,
        country: market,
        n: offers.length,
        price: roundPrice(bestPrice, bestCurrency),
        cur: bestCurrency,
      }),
      sku: product.productId,
      url,
      ...(brand ? { brand: { "@type": "Brand" as const, name: brand } } : {}),
      ...(image ? { image: [image] } : {}),
      offers,
    });
  }

  return nodes;
}

export interface BuildProductStructuredDataArgs {
  /** The product identity the page painted (title/brand/image/id). */
  product: NormalizedProduct;
  /** The offer rows the page rendered, already merged/scoped/deduped by the
   *  same helpers the PDP uses. */
  offers: readonly LiveOffer[];
  locale: Locale;
  country: CountryCode | null;
  /** One baked server render clock, same value threaded through the page. */
  nowMs: number;
  origin: string;
  /** The URL the page's canonical tag declares (one URL per product). */
  canonicalProductId: string;
}

/**
 * REEA-1168 AC-7 (2026-11-26 scope delta) — Product/Offer JSON-LD for a PDP.
 *
 * The PDP is the URL organic traffic lands on, so it must describe the same
 * live-collected offer rows it paints. This builder takes the rows the page
 * already rendered (inherited stamped observations + this run's live re-checks,
 * merged/deduped by the PDP's own helpers) and emits one Product node with one
 * Offer per row that carries its own observation stamp inside the freshness
 * window. No fresh row → null, so a zero-offer page makes no price claim.
 *
 * Pure projection: no second fan-out, no client fetch, no clock of its own.
 */
export function buildProductStructuredData(
  args: BuildProductStructuredDataArgs,
): ProductJsonLd | null {
  const { product, offers, locale, country, nowMs, origin, canonicalProductId } = args;
  const eligible: { offer: LiveOffer; observedAtMs: number; price: number }[] = [];
  for (const offer of offers) {
    const observedAtMs = Date.parse(offer.collectedAt ?? "");
    if (!Number.isFinite(observedAtMs)) continue;
    // Future stamps (clock skew) are treated as just-observed, never stale.
    if (Math.max(0, nowMs - observedAtMs) > STRUCTURED_DATA_FRESHNESS_MS) continue;
    // REEA-1212 — price the row at the same "You pay" figure the PDP prints,
    // never a second subtraction of the was-price/coupon evidence.
    const price = payableNativePrice(offer);
    if (price === null) continue;
    if (!offer.currency?.trim()) continue;
    eligible.push({ offer, observedAtMs, price });
  }
  if (eligible.length === 0) return null;

  const cheapest = eligible.reduce((best, row) =>
    row.price < best.price ? row : best,
  );
  const currency = cheapest.offer.currency.trim().toUpperCase();
  const price = roundPrice(cheapest.price, currency);
  const url = productPageUrl(origin, canonicalProductId);
  const offersJson: OfferJsonLd[] = eligible.map(({ offer, observedAtMs, price }) => ({
    "@type": "Offer",
    url: safeHref(offer.url) ?? url,
    price: roundPrice(price, offer.currency),
    priceCurrency: offer.currency.trim().toUpperCase(),
    availability: offer.inStock
      ? `${SCHEMA_ORG}/InStock`
      : `${SCHEMA_ORG}/OutOfStock`,
    seller: { "@type": "Organization", name: offer.merchant },
    validFrom: new Date(observedAtMs).toISOString(),
    priceValidUntil: isoDate(observedAtMs + STRUCTURED_DATA_FRESHNESS_MS),
  }));

  const title = product.title?.trim() || product.productId;
  const image = absoluteImage(
    product.image ?? product.offers.find((offer) => offer.image)?.image,
    origin,
  );
  const brand = product.brand?.trim();
  const t = getStrings(locale);
  const market = countryLabel(country, locale);

  return {
    "@context": SCHEMA_ORG,
    "@type": "Product",
    name: fill(t.jsonLdProductName, { title, country: market }),
    description: fill(t.jsonLdProductDescription, {
      title,
      country: market,
      n: offersJson.length,
      price,
      cur: currency,
    }),
    sku: product.productId,
    url,
    ...(brand ? { brand: { "@type": "Brand" as const, name: brand } } : {}),
    ...(image ? { image: [image] } : {}),
    offers: offersJson,
  };
}

/** Serialize one JSON-LD block for a <script> tag. `<` is escaped so a
 *  retailer title containing `</script>` cannot terminate the element. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
