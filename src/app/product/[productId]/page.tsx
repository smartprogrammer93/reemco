import Link from "next/link";
import { notFound } from "next/navigation";
import ProductResultCard from "@/components/ProductResultCard";
import CollectionPanel from "@/components/CollectionPanel";
import { startProductCollectionStaged } from "@/lib/collect/runner";
import { PRODUCTS } from "@/lib/feed";
import { resolveProductIdentity } from "@/lib/product-identity";
import {
  buildResultsHref,
  filterProductsByCountry,
  sanitizeCountry,
} from "@/lib/country";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

export const metadata = {
  title: "Product — Reemco",
};

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
  const { c } = await searchParams;
  const country = sanitizeCountry(c);
  // REEA-279 — chrome locale for the detail card, the live panel and the
  // back link; cookie → Accept-Language hint → "en".
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  const product = await resolveProductIdentity(productId, country);
  if (!product) notFound();
  // Catalog identities carry bundled offers — apply the same selection the
  // live path applies before grouping (idempotent on live-resolved products).
  const shown = filterProductsByCountry([product], country)[0];
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
  const firstStage = process.env.STATIC_EXPORT
    ? undefined
    : startProductCollectionStaged(shown)
        .then((s) => s.firstStage)
        // a handshake that never started is not an error state: the panel
        // falls back to its old client-initiated path (see CollectionPanel).
        .then(
          (snap) => snap,
          () => null,
        );

  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      {/* Theme v1 §3.4: product hero uses the detail variant (28px price, variations, alternatives). */}
      <ProductResultCard product={shown} isBest variant="detail" country={country} locale={locale} />
      {/* REEA-84 W1: live per-product collection with progress UX (T4/T5/T6).
          Client-only — degrades to the catalog card above when the API is
          unavailable, e.g. on the static preview host (AC10). */}
      <CollectionPanel
        productId={shown.productId}
        currency={shown.offers[0]?.currency ?? "KWD"}
        country={country}
        locale={locale}
        firstStage={firstStage}
      />
      <p style={{ marginTop: "var(--rc-space-4)" }}>
        <Link
          href={buildResultsHref(shown.title, 1, country)}
          className="hover:underline"
          style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
        >
          {t.allOffersLead}
        </Link>
      </p>
    </div>
  );
}
