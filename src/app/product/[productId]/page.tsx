import Link from "next/link";
import { notFound } from "next/navigation";
import ProductResultCard from "@/components/ProductResultCard";
import CollectionPanel from "@/components/CollectionPanel";
import { PRODUCTS, resolveProductIdentity } from "@/lib/feed";
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
export const maxDuration = 20;

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
