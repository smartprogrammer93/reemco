"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface SearchFormProps {
  initialQuery: string;
}

export default function SearchForm({ initialQuery }: SearchFormProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = value.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  return (
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
  );
}
