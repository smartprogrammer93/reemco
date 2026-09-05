import ResultsClient from "@/components/ResultsClient";

export const metadata = {
  title: "Results — Reemco",
};

/* /search?q= is the canonical results URL from the theme spec (§4); it renders
   the same themed results view as /results so both addresses stay valid. */
export default function SearchPage() {
  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--layout-max-w)" }}
    >
      <ResultsClient />
    </div>
  );
}
