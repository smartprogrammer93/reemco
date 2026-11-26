/**
 * REEA-1168 / REEA-1212 — server-only JSON-LD block for the live results
 * surface.
 *
 * It awaits the SAME staged promises the page already streams, and folds them
 * through the renderer's own paint chain (`paintedShelfCardsAcrossStages`), so
 * the structured data describes the exact cards the shopper's document paints
 * — not a different snapshot or a second offer definition. No client fetch,
 * no second fan-out and no extra admission slot. The parent renders this
 * inside a Suspense boundary, so the shell (query h1, canonical, filter
 * chrome) still flushes first and the script lands once the run finalizes.
 */
import { siteOrigin } from "@/lib/site-origin";
import { buildResultsStructuredData, serializeJsonLd } from "@/lib/structured-data";
import { paintedShelfCardsAcrossStages } from "@/lib/results-shelf";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import type { CountryCode } from "@/lib/country";
import type { Locale } from "@/lib/i18n";
import type { NormalizedProduct } from "@/types/product";

export interface ResultsStructuredDataProps {
  /** The same staged run ResultsClient paints (server-streamed promises). */
  stages: readonly Promise<LiveSearchResult>[];
  query: string;
  country: CountryCode | null;
  locale: Locale;
  /** One baked server render clock, the same value threaded through the page. */
  nowMs: number;
  page: number;
  showOutOfStock: boolean;
}

export default async function ResultsStructuredData(props: ResultsStructuredDataProps) {
  // REEA-1212 — the shopper-visible card population, computed with the exact
  // helper the renderer's paint chain and the metrics fold use. A rejected
  // stage contributes nothing (the honest state of a flush that never landed).
  let cards: NormalizedProduct[];
  try {
    cards = await paintedShelfCardsAcrossStages(
      props.stages,
      props.query,
      props.page,
      props.country,
      props.showOutOfStock,
    );
  } catch {
    // A failed paint chain has no price claim to make.
    return null;
  }
  if (cards.length === 0) return null;

  // The last stage carries the run's collection stamp, used only as a
  // fallback observation time for offers that carry none of their own.
  let snapshot: LiveSearchResult | undefined;
  try {
    snapshot = await props.stages[props.stages.length - 1];
  } catch {
    snapshot = undefined;
  }

  const nodes = buildResultsStructuredData({
    cards,
    snapshot: snapshot && Array.isArray(snapshot.products) ? snapshot : undefined,
    query: props.query,
    country: props.country,
    locale: props.locale,
    nowMs: props.nowMs,
    origin: siteOrigin(),
    page: props.page,
    showOutOfStock: props.showOutOfStock,
  });
  if (nodes.length === 0) return null;

  return (
    <>
      {nodes.map((node) => (
        <script
          key={node.sku}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(node) }}
        />
      ))}
    </>
  );
}
