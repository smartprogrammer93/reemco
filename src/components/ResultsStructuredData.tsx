/**
 * REEA-1168 — server-only JSON-LD block for the live results surface.
 *
 * It awaits the SAME `staged.final` promise the page already streams, so the
 * structured data describes the snapshot the page actually served and adds no
 * client fetch, no second fan-out and no extra admission slot. The parent
 * renders this inside a Suspense boundary, so the shell (query h1, canonical,
 * filter chrome) still flushes first and the script lands in the served
 * document as soon as the run finalizes.
 */
import { siteOrigin } from "@/lib/site-origin";
import { buildResultsStructuredData, serializeJsonLd } from "@/lib/structured-data";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import type { CountryCode } from "@/lib/country";
import type { Locale } from "@/lib/i18n";

export interface ResultsStructuredDataProps {
  final: Promise<LiveSearchResult>;
  query: string;
  country: CountryCode | null;
  locale: Locale;
  /** One baked server render clock, the same value threaded through the page. */
  nowMs: number;
  page: number;
  showOutOfStock: boolean;
}

export default async function ResultsStructuredData(props: ResultsStructuredDataProps) {
  let snapshot: LiveSearchResult;
  try {
    snapshot = await props.final;
  } catch {
    // A failed stage boundary has no price claim to make.
    return null;
  }
  if (!snapshot || !Array.isArray(snapshot.products)) return null;

  const nodes = buildResultsStructuredData({
    snapshot,
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
