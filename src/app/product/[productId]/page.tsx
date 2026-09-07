import Link from "next/link";
import { notFound } from "next/navigation";
import ProductResultCard from "@/components/ProductResultCard";
import CollectionPanel from "@/components/CollectionPanel";
import { PRODUCTS, resolveProductIdentity } from "@/lib/feed";

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
}: PageProps<"/product/[productId]">) {
  const { productId } = await params;
  const product = await resolveProductIdentity(productId);
  if (!product) notFound();

  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--rc-layout-max-w)" }}
    >
      {/* Theme v1 §3.4: product hero uses the detail variant (28px price, variations, alternatives). */}
      <ProductResultCard product={product} isBest variant="detail" />
      {/* REEA-84 W1: live per-product collection with progress UX (T4/T5/T6).
          Client-only — degrades to the catalog card above when the API is
          unavailable, e.g. on the static preview host (AC10). */}
      <CollectionPanel
        productId={product.productId}
        currency={product.offers[0]?.currency ?? "KWD"}
      />
      <p style={{ marginTop: "var(--rc-space-4)" }}>
        <Link
          href={`/results?q=${encodeURIComponent(product.title)}`}
          className="hover:underline"
          style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
        >
          ← All offers for this product
        </Link>
      </p>
    </div>
  );
}
