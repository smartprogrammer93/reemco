/** Brief v4 search: hero 52px / compact 44px (AC6 tap floor) input + button.
 *  defaultValue echoes the active ?q so the query survives retry (AC5). */
export default function SearchForm({
  compact = false,
  defaultValue,
}: {
  compact?: boolean;
  defaultValue?: string;
}) {
  const height = compact ? 44 : 52;
  return (
    <form
      key={defaultValue ?? ""}
      action="/results"
      method="get"
      className="flex flex-wrap gap-2 sm:flex-nowrap"
      role="search"
    >
      {/* REEA-75: min-w-0 lets the input shrink below its intrinsic width;
          basis-full stacks it above the button under sm (375px-safe). */}
      <input
        type="search"
        name="q"
        placeholder="Search for a product…"
        aria-label="Search for a product"
        defaultValue={defaultValue}
        className="text-input focusable min-w-0 flex-1 basis-full px-4 sm:basis-auto"
        style={{ height }}
      />
      <button
        type="submit"
        className="btn-primary focusable w-full min-h-11 px-6 sm:w-auto"
        style={{ height }}
      >
        Search
      </button>
    </form>
  );
}
