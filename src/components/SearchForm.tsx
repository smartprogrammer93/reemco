export default function SearchForm() {
  return (
    <form action="/results" method="get" className="flex gap-2" role="search">
      <input
        type="search"
        name="q"
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
  );
}
