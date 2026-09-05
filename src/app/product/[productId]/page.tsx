import Link from "next/link";
import { notFound } from "next/navigation";
import ProductResultCard from "@/components/ProductResultCard";
import { PRODUCTS } from "@/lib/feed";

export const metadata = {
  title: "Product — Reemco",
};

/* Static export: pre-render one page per catalog product. */
export function generateStaticParams() {
  return PRODUCTS.map((p) => ({ productId: p.productId }));
}

export default async function ProductPage({
  params,
}: PageProps<"/product/[productId]">) {
  const { productId } = await params;
  const product = PRODUCTS.find((p) => p.productId === productId);
  if (!product) notFound();

  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--layout-max-w)" }}
    >
      {/* Theme v1 §3.4: product hero uses the detail variant (28px price, variations, alternatives). */}
      <ProductResultCard product={product} isBest variant="detail" />
      <p style={{ marginTop: "var(--space-4)" }}>
        <Link
          href={`/results?q=${encodeURIComponent(product.title)}`}
          className="hover:underline"
          style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
        >
          ← All offers for this product
        </Link>
      </p>
    </div>
  );
}
