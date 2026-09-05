import ResultsClient from "@/components/ResultsClient";

export const metadata = {
  title: "Results — Reemco",
};

export default function ResultsPage() {
  return (
    <div
      className="mx-auto w-full px-6 py-6"
      style={{ maxWidth: "var(--layout-max-w)" }}
    >
      <ResultsClient />
    </div>
  );
}
