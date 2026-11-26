/**
 * REEA-1168 AC-7 (2026-11-26 scope delta) — server-only Product/Offer JSON-LD
 * for the product-detail page.
 *
 * The PDP is the URL organic traffic lands on, so it must describe the same
 * live-collected offer rows it paints. This component awaits the SAME staged
 * collection the page already started (`finalStage`) and applies the PDP's own
 * merge/dedupe/market-scope helpers to the inherited stamped observations plus
 * this run's live re-checks — no second fan-out, no client fetch. It renders
 * inside a Suspense boundary so the shell (title, H1, hero) still flushes
 * first, and the script lands as soon as the run settles.
 *
 * No fresh row → null (no price claim), matching the site's freshness rule.
 */
import { hasCollectionStamp } from "@/lib/collect/last-observation";
import type { CollectJob, LiveOffer } from "@/lib/collect/types";
import type { CountryCode } from "@/lib/country";
import type { Locale } from "@/lib/i18n";
import { marketViewScope, scopeProductsByMarket } from "@/lib/market";
import { dedupeRetailerOfferRows, mergeInheritedOfferRows } from "@/lib/offer-rows";
import { siteOrigin } from "@/lib/site-origin";
import {
  buildProductStructuredData,
  serializeJsonLd,
} from "@/lib/structured-data";
import type { NormalizedProduct } from "@/types/product";

export interface ProductStructuredDataProps {
  /** The page's staged collection; resolves with the terminal job. */
  final: Promise<CollectJob | null>;
  /** The identity the page painted (already seeded with last observations). */
  product: NormalizedProduct;
  country: CountryCode | null;
  locale: Locale;
  /** One baked server render clock, the same value threaded through the page. */
  nowMs: number;
  /** The URL the page's canonical tag declares. */
  canonicalProductId: string;
}

export default async function ProductStructuredData(
  props: ProductStructuredDataProps,
) {
  let job: CollectJob | null = null;
  try {
    job = await props.final;
  } catch {
    // A failed stage boundary still has the inherited stamped rows to describe.
    job = null;
  }

  const inherited = ((props.product.offers ?? []) as unknown as LiveOffer[]).filter(
    hasCollectionStamp,
  );
  const live = job?.offers ?? [];
  const merged = mergeInheritedOfferRows(inherited, live);
  if (merged.length === 0) return null;

  const scoped = scopeProductsByMarket(
    [
      {
        ...props.product,
        offers: merged as unknown as NormalizedProduct["offers"],
      },
    ],
    marketViewScope(props.country),
  )[0].offers as unknown as LiveOffer[];
  // Same row set the offer table renders: one row per distinct retailer offer.
  const rows = dedupeRetailerOfferRows(scoped);

  const node = buildProductStructuredData({
    product: props.product,
    offers: rows,
    locale: props.locale,
    country: props.country,
    nowMs: props.nowMs,
    origin: siteOrigin(),
    canonicalProductId: props.canonicalProductId,
  });
  if (!node) return null;

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(node) }}
    />
  );
}
