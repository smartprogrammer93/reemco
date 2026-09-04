import ResultsClient from "@/components/ResultsClient";
import SearchForm from "@/components/SearchForm";

export const metadata = {
  title: "Results — Reemco",
};

export default function ResultsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">
        Reemco price comparison
      </h1>
      <div className="mb-8">
        <SearchForm />
      </div>
      <ResultsClient />
    </div>
  );
}
