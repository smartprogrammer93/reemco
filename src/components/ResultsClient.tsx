"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ProductResultCard from "@/components/ProductResultCard";
import { STUB_PRODUCTS, filterProducts } from "@/lib/feed";

function Results() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const products = query
    ? filterProducts(STUB_PRODUCTS, query)
    : STUB_PRODUCTS;

  return (
    <>
      <p className="mb-6 text-sm text-zinc-500">
        {products.length} result{products.length === 1 ? "" : "s"} for{" "}
        <span className="font-medium text-foreground">
          &ldquo;{query || "all products"}&rdquo;
        </span>
      </p>
      {products.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No results.{" "}
          <Link href="/search" className="underline underline-offset-2">
            Search again
          </Link>
        </p>
      ) : (
        <div className="space-y-6">
          {products.map((p) => (
            <ProductResultCard key={p.productId} product={p} />
          ))}
        </div>
      )}
    </>
  );
}

export default function ResultsClient() {
  return (
    <Suspense
      fallback={<p className="text-sm text-zinc-500">Loading results…</p>}
    >
      <Results />
    </Suspense>
  );
}
