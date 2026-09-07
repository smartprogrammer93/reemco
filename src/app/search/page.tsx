import ResultsPage from "@/app/results/page";

export const metadata = {
  title: "Results — Reemco",
};

// Match the /results segment so both addresses stay on one live path (REEA-114).
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/* /search?q= is the canonical results URL from the theme spec (§4); it renders
   the same server-collection path as /results so both addresses stay valid. */
export default function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return <ResultsPage searchParams={searchParams} />;
}
