import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import ProductHero from "@/components/ProductHero";
import { seedCatalogPageWithLastObservation } from "@/lib/collect/last-observation";
import { startProductCollectionStaged } from "@/lib/collect/runner";
import type { StagedProductCollection } from "@/lib/collect/runner";
import { PRODUCTS } from "@/lib/feed";
import { resolveProductIdentity } from "@/lib/product-identity";
import {
  canonicalProductIdForSlug,
  humanizeProductSlug,
  productTitleForId,
} from "@/lib/product-canonical";
import { resolveResultsMarket } from "@/lib/country";
import { countryLabel } from "@/lib/results-meta";
import { fill, getStrings } from "@/lib/i18n";
import { marketViewScope, scopeProductsByMarket } from "@/lib/market";
import { resolveRequestLocale } from "@/lib/i18n-server";
import { sanitizeSearchQuery } from "@/lib/search-params";
import { siteOrigin } from "@/lib/site-origin";

/**
 * REEA-1189 — a product page is an indexed URL too: it must carry a
 * product-specific title/description and a self-referencing canonical that
 * matches the one URL the sitemap lists. The canonical id folds a live merge
 * slug onto its catalog identity when they name the same SKU, so the same
 * product never advertises two URLs. Resolution here is slug/title-only (no
 * live fan-out), so generateMetadata adds no render cost to the page.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<Metadata> {
  const { productId } = await params;
  const { c, market } = await searchParams;
  const locale = await resolveRequestLocale();
  const country = resolveResultsMarket(market, c, undefined, undefined);
  const canonicalId = canonicalProductIdForSlug(productId);
  const title = productTitleForId(canonicalId) ?? humanizeProductSlug(productId);
  const marketLabel = countryLabel(country, locale);
  const strings = getStrings(locale);
  return {
    title: fill(strings.productMetaTitle, { title, country: marketLabel }),
    description: fill(strings.productMetaDescription, {
      title,
      country: marketLabel,
    }),
    alternates: {
      canonical: `${siteOrigin()}/product/${encodeURIComponent(canonicalId)}`,
    },
  };
}

// REEA-114: identities not in the catalog resolve through the live fan-out,
// so the page must render per request (server builds), not be pre-baked.
export const dynamic = "force-dynamic";
// Same measured-walk headroom tier as the results segment (REEA-391): the
// detail page runs its own live collection on cold visits, and the QA repro
// on the health funnel measured this walk past the old 20 s ceiling too.
export const maxDuration = 45;

/* Static export: pre-render one page per catalog product. */
export function generateStaticParams() {
  return PRODUCTS.map((p) => ({ productId: p.productId }));
}

export default async function ProductPage({
  params,
  searchParams,
}: PageProps<"/product/[productId]">) {
  const { productId } = await params;
  // REEA-170: the country selection rides the link from the results list, so
  // the detail view derives its prices/alternatives from the same filtered
  // offer set. No param → unchanged behavior.
  const { c, market, q } = await searchParams;
  // REEA-1177 AC 6d-2 — the PDP carries the same addressable market state as
  // the shelf it was reached from; a direct visit defaults to Kuwait.
  const country = resolveResultsMarket(market, c, undefined, undefined);
  // REEA-1140 — the results card carries the query it was collected for, so
  // the detail page re-runs the SAME live fan-out and merge map. A slug-only
  // visit (shared link, sitemap) keeps the decode-from-slug path.
  const carriedQuery = sanitizeSearchQuery(q);
  // REEA-283/REEA-1091 — one clock reading per server render, taken BEFORE the
  // live fan-out starts. It is threaded into the hero card and the live panel
  // (and down to every offer card), so the served HTML and the hydration pass
  // derive the same "Checked Ns ago" / freshness / elapsed labels. Without a
  // baked value the client components fall back to Date.now() DURING render,
  // which recomputes on hydration and logs React #418 (text mismatch).
  // eslint-disable-next-line react-hooks/purity -- intentional single clock read per server render (REEA-283); hydration reuses the serialized value.
  const renderStartMs = Date.now();
  // REEA-279 — chrome locale for the detail card, the live panel and the
  // back link; cookie → Accept-Language hint → "en".
  const locale = await resolveRequestLocale();
  const product = await resolveProductIdentity(productId, country, carriedQuery);
  if (!product) notFound();
  // Catalog identities carry bundled offers — apply the same market scope the
  // live path applies (REEA-1142: every offer stays, tagged to its market;
  // the renderer labels cross-market rows). Idempotent on live products.
  const shown = scopeProductsByMarket([product], marketViewScope(country))[0];
  // REEA-1211 — a catalog seed carries no collection stamp, so its page paints
  // only what this request's live fan-out confirms. When the identity's only
  // listing is unreliable (keychron-v3-max: one amazon.eg search listing that
  // answers HTTP 503 for long stretches) that means an empty offer table — a
  // sitemap URL advertised to crawlers that renders no offer. Seed the page
  // with the last COMPLETED collection from the shared store instead: those
  // rows carry their own collectedAt, are marked "cache" (Needs verification,
  // not this run's Verified), and are replaced row-by-row by this run's live
  // re-checks. The sitemap asks the same question (lib/collect/last-observation)
  // before advertising the URL, so the two surfaces cannot disagree.
  const painted = await seedCatalogPageWithLastObservation(shown);
  // REEA-248 — start the live per-product collection during the server render
  // (the detail-page sibling of results-page streaming): the panel's first
  // retailer offer rides the streamed HTML with no click needed, and the
  // client only continues the same job by polling afterwards — no second POST
  // on first paint. The static preview host keeps its old client-initiated
  // path (no shared job store there; see CollectionPanel AC10 note).
  // REEA-693 item 1 — the job handshake no longer holds up the shell: the
  // stage rides into the panel boundary AS A PROMISE (consumed via use() in
  // CollectionPanel), so the hero + panel fallback flush with the first chunk
  // (shell <= 2s) and the first offer lands in its own streamed boundary as
  // soon as a retailer answers. The manual Collect-now stays exactly as it
  // is — the no-JS / boundary-not-yet-flushed fallback.
  // REEA-882 — the page keeps the full StagedProductCollection handle (not
  // just firstStage) and registers `after()` on the run's finalStage, so the
  // serverless invocation outlives the streamed response until the WHOLE run
  // settles (the runner's own budget watchdog finalizes terminal states).
  // Holding only firstStage left the rest of runCollection a floating
  // promise: the invocation froze when the stream ended, the runner died
  // mid-run with subtasks stuck `collecting`, and the REEA-870 reap marked
  // every product-page job `failed` with 0 offers at ~30s. Same shape as the
  // results page (`staged.allSettled` behind after(), REEA-398).
  const stagedCollection: Promise<StagedProductCollection | null> | undefined =
    process.env.STATIC_EXPORT
      ? undefined
      : startProductCollectionStaged(painted).then(
          (s) => s,
          () => null,
        );
  const firstStage = stagedCollection?.then((s) => s?.firstStage ?? null);

  // REEA-882 — keep the invocation alive past the streamed response until the
  // run's tail finalizes: the page-level counterpart of the results page's
  // `after(() => staged.allSettled)` (REEA-398). Registered on the page, not
  // in the runner lib, so the runner stays request-scope-free for tests.
  // maxDuration (45s) already covers the runner's 10s budget with headroom.
  if (stagedCollection) {
    after(() =>
      stagedCollection.then(
        (s) => s?.finalStage,
        // a start that never began has no run tail to keep alive.
        () => undefined,
      ),
    );
  }

  return (
    <ProductHero
      product={painted}
      country={country}
      locale={locale}
      query={carriedQuery ?? ""}
      firstStage={firstStage}
      renderStartMs={renderStartMs}
    />
  );
}
