/** Theme v1 §3.2 hero search bar: 48px input + primary button, radius 6. */
export default function SearchForm({ compact = false }: { compact?: boolean }) {
  const height = compact ? 40 : 48;
  return (
    <form action="/results" method="get" className="flex gap-2" role="search">
      <input
        type="search"
        name="q"
        placeholder="Search for a product…"
        aria-label="Search for a product"
        className="text-input focusable flex-1 px-4"
        style={{ height }}
      />
      <button type="submit" className="btn-primary focusable px-6" style={{ height }}>
        Search
      </button>
    </form>
  );
}
