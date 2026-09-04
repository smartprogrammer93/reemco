"use client";

import { useMemo, useState, type FormEvent } from "react";
import { STUB_PRODUCTS, filterProducts } from "@/lib/feed";

export default function SearchClient() {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState("");

  const products = useMemo(
    () => (submitted ? filterProducts(STUB_PRODUCTS, submitted) : null),
    [submitted],
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(value.trim());
  }

  return (
    <div className="w-full">
      <form onSubmit={onSubmit} className="flex gap-2" role="search">
        <input
          type="search"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search for a product…"
          aria-label="Search for a product"
          className="flex-1 rounded-full border border-zinc-300 px-4 py-2 text-sm outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          className="rounded-full bg-foreground text-background px-5 py-2 text-sm font-medium hover:opacity-90"
        >
          Search
        </button>
      </form>

      {products === null ? (
        <p className="mt-10 text-sm text-zinc-500">
          Enter a product to compare prices. Results render price, availability,
          coupons, variations, and alternatives once the normalized data feed is
          wired in.
        </p>
      ) : products.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500">
          No results for &ldquo;{submitted}&rdquo;.
        </p>
      ) : (
        <ul className="mt-10 space-y-4">
          {products.map((p) => {
            const best = p.offers.reduce(
              (a, b) => (b.price < a.price ? b : a),
              p.offers[0],
            );
            return (
              <li key={p.productId} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{p.title}</span>
                  <span className="tabular-nums">
                    from ${best.price.toFixed(2)} ({best.merchant}
                    {best.inStock ? "" : ", out of stock"})
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  {p.coupons.length > 0 && (
                    <span className="text-emerald-700">
                      Coupon: {p.coupons[0].discount} —{" "}
                      {p.coupons[0].description}
                    </span>
                  )}
                  <span>
                    {p.variations.length} variation
                    {p.variations.length === 1 ? "" : "s"},{" "}
                    {p.alternatives.length} alternative
                    {p.alternatives.length === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
