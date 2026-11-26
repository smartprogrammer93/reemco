/**
 * REEA-1168 — Product/Offer structured data for the live results surface.
 *
 * The company data policy forbids presenting stale data as live, so this
 * module never invents a price claim: an Offer is emitted only when the
 * snapshot carries an observation timestamp inside the site's own freshness
 * window (OFFER_STATUS_STALE_MS, the same 24 h threshold the visible status
 * token uses — lib/offer-status.ts). A product whose offers all fall outside
 * that window emits no Product node at all, so a crawler never reads a price
 * the page itself would label "Stale".
 *
 * Everything here is a pure projection of the SAME live snapshot the page
 * paints: the shelf chain (lib/results-shelf.ts) selects the cards, and each
 * offer keeps its own retailer name, URL and observation stamp. No bundled
 * catalogue, no second fetch, no client work — the script tag is rendered by
 * a server component (components/ResultsStructuredData.tsx).
 */
import type { CountryCode } from "@/lib/country";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import { proxiedImageSrc } from "@/lib/image-proxy";
import { OFFER_STATUS_STALE_MS } from "@/lib/offer-status";
import { catalogProductIdFor } from "@/lib/product-canonical";
import { resultsShelfCards } from "@/lib/results-shelf";
import { countryLabel } from "@/lib/results-meta";
import { safeHref } from "@/lib/safe-url";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

export const SCHEMA_ORG = "https://schema.org";

/** The site's offer freshness window: the same 24 h threshold the visible
 *  status system uses to label an offer "Stale". `priceValidUntil` is derived
 *  from the observation stamp plus this window, so a structured-data price can
 *  never outlive the freshness claim the page makes. */
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
  price: number;
  priceCurrency: string;
  availability: string;
  seller: { "@type": "Organization"; name: string };
  /** The observation timestamp for THIS offer (retailer hop / collection). */
  validFrom: string;
  /** Observation stamp + the site freshness window. */
  priceValidUntil: string;
}

export interface StructuredDataSnapshot {
  products: readonly NormalizedProduct[];
  collectedAt?: string;
  collectedAtEpochMs?: number;
}

export interface BuildStructuredDataArgs {
  snapshot: StructuredDataSnapshot;
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
 *  stamp. Returns null when the record carries no usable timestamp — such an
 *  offer is not emitted, because there is no freshness claim to make. */
function observationMs(
  offer: PriceOffer,
  product: NormalizedProduct,
  snapshot: StructuredDataSnapshot,
): number | null {
  return (
    finiteMs(offer.collectedAtEpochMs) ??
    parseMs(offer.collectedAt) ??
    finiteMs(product.scrapedAtEpochMs) ??
    parseMs(product.scrapedAt) ??
    finiteMs(snapshot.collectedAtEpochMs) ??
    parseMs(snapshot.collectedAt)
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

interface EligibleOffer {
  offer: PriceOffer;
  observedAtMs: number;
}

/** Offers that may carry a price claim: a real observation stamp inside the
 *  freshness window, not a sanity-flagged figure, and not a last-seen replay
 *  (the scope says "offers the page actually collected live"). */
function eligibleOffers(
  product: NormalizedProduct,
  snapshot: StructuredDataSnapshot,
  nowMs: number,
): EligibleOffer[] {
  const out: EligibleOffer[] = [];
  for (const offer of product.offers ?? []) {
    if (offer.sanity?.status === "flagged") continue;
    if (offer.fromSnapshot === true) continue;
    const observedAtMs = observationMs(offer, product, snapshot);
    if (observedAtMs === null) continue;
    // Future stamps (clock skew) are treated as just-observed, never stale.
    const ageMs = Math.max(0, nowMs - observedAtMs);
    if (ageMs > STRUCTURED_DATA_FRESHNESS_MS) continue;
    if (!Number.isFinite(offer.price) || offer.price < 0) continue;
    const currency = offer.currency?.trim();
    if (!currency) continue;
    out.push({ offer, observedAtMs });
  }
  return out;
}

/**
 * Build one Product node per visible shelf card that carries at least one
 * fresh live offer. The shelf chain is the renderer's own (REEA-1099), so the
 * structured data describes exactly the cards the page painted on this page
 * slice. Returns [] when nothing has a claimable fresh price.
 */
export function buildResultsStructuredData(args: BuildStructuredDataArgs): ProductJsonLd[] {
  const { snapshot, query, country, locale, nowMs, origin } = args;
  const cards = resultsShelfCards(
    snapshot,
    query,
    args.page ?? 1,
    country,
    args.showOutOfStock ?? false,
  );
  const t = getStrings(locale);
  const market = countryLabel(country, locale);
  const nodes: ProductJsonLd[] = [];

  for (const product of cards) {
    const eligible = eligibleOffers(product, snapshot, nowMs);
    if (eligible.length === 0) continue;

    const title = product.title?.trim() || query.trim() || product.productId;
    const cheapest = eligible.reduce((best, row) =>
      row.offer.price < best.offer.price ? row : best,
    );
    const currency = cheapest.offer.currency.trim().toUpperCase();
    const price = roundPrice(cheapest.offer.price, currency);
    // REEA-1189 — point at the same canonical URL the sitemap lists when the
    // live SKU is the catalog seed's own identity. Live-only SKUs keep their
    // merge slug; a catalog-covered product must not advertise a second URL.
    const canonicalId = catalogProductIdFor(product) ?? product.productId;
    const url = productPageUrl(origin, canonicalId);

    const offers: OfferJsonLd[] = eligible.map(({ offer, observedAtMs }) => ({
      "@type": "Offer",
      url: safeHref(offer.url) ?? url,
      price: roundPrice(offer.price, offer.currency),
      priceCurrency: offer.currency.trim().toUpperCase(),
      availability: offer.inStock
        ? `${SCHEMA_ORG}/InStock`
        : `${SCHEMA_ORG}/OutOfStock`,
      seller: { "@type": "Organization", name: offer.merchant },
      validFrom: new Date(observedAtMs).toISOString(),
      priceValidUntil: isoDate(observedAtMs + STRUCTURED_DATA_FRESHNESS_MS),
    }));

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
        price,
        cur: currency,
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

/** Serialize one JSON-LD block for a <script> tag. `<` is escaped so a
 *  retailer title containing `</script>` cannot terminate the element. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
