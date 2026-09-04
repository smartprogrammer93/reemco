"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PRODUCTS } from "@/lib/feed";
import { searchProducts } from "@/lib/search";

export default function SearchClient() {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState("");
  const router = useRouter();

  const products = useMemo(
    () => (submitted ? searchProducts(submitted, PRODUCTS).map((m) => m.product) : null),
    [submitted],
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = value.trim();
    setSubmitted(q);
    if (q) router.push(`/results?q=${encodeURIComponent(q)}`);
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
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Search
        </button>
      </form>

      {products !== null && products.length === 0 && (
        <p className="mt-10 text-sm text-zinc-500">
          No results for &ldquo;{submitted}&rdquo;.
        </p>
      )}
    </div>
  );
}
