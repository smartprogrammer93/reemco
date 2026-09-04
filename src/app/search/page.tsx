import SearchClient from "@/components/SearchClient";

export const metadata = {
  title: "Search — Reemco",
};

export default function SearchPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">
        Reemco price comparison
      </h1>
      <SearchClient />
    </div>
  );
}
