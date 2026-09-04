import SearchForm from "@/components/SearchForm";
import { searchProducts } from "@/lib/feed";

export const metadata = {
  title: "Search — Reemco",
};

interface SearchPageProps {
  searchParams: Promise<{ q?: string | string[] }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q : "";
  const result = query ? await searchProducts(query) : null;

  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">
        Reemco price comparison
      </h1>

      <SearchForm initialQuery={query} />

      {result === null ? (
        <p className="mt-10 text-sm text-zinc-500">
          Enter a product to compare prices. (Results render price,
          availability, coupons, variations, and alternatives once the
          normalized data feed is wired in.)
        </p>
      ) : result.products.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500">
          No results for &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="mt-10 space-y-4">
          {result.products.map((p) => {
            const best = p.offers.reduce(
              (a, b) => (b.price < a.price ? b : a),
              p.offers[0],
            );
            return (
              <li key={p.productId} className="rounded-xl border p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">{p.title}</span>
                  <span className="tabular-nums">
                    from ${best.price.toFixed(2)} ({best.merchant}
                    {best.inStock ? "" : ", out of stock"})
                  </span>
                </div>
                {p.coupons.length > 0 && (
                  <p className="mt-1 text-xs text-emerald-700">
                    Coupon: {p.coupons[0].discount} — {p.coupons[0].description}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
