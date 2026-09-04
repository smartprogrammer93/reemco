import ResultsClient from "@/components/ResultsClient";
import SearchForm from "@/components/SearchForm";

export const metadata = {
  title: "Results — Reemco",
};

export default function ResultsPage() {
  return (
    <div className="mx-auto w-full max-w-[1040px] px-6 py-6">
      {/* F1: display-scale title, 32px below to first card, 24px page top padding */}
      <h1 className="text-[28px] font-bold leading-[34px]" style={{ color: "var(--brand-ink)" }}>
        Results
      </h1>
      <div className="mb-8 mt-4">
        <SearchForm />
      </div>
      <ResultsClient />
    </div>
  );
}
