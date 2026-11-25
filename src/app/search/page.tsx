import ResultsPage from "@/app/results/page";
import { sanitizeSearchQuery, sanitizePage } from "@/lib/search-params";
import { siteOrigin } from "@/lib/site-origin";
import type { Metadata } from "next";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * REEA-1168 AC-3 — /search?q= renders the same live path as /results?q=, so it
 * advertises the ONE canonical shape (/results?q=) instead of competing with
 * it in the index. The page body itself is the shared ResultsPage component.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const query = sanitizeSearchQuery(params.q) ?? "";
  const page = sanitizePage(params.page);
  const queryPart = query ? `?q=${encodeURIComponent(query)}` : "";
  const pagePart = page > 1 ? `${queryPart ? "&" : "?"}page=${page}` : "";
  const canonical = `${siteOrigin()}/results${queryPart}${pagePart}`;
  return {
    title: "Results — Reemco",
    alternates: { canonical },
  };
}

// Match the /results segment so both addresses stay on one live path (REEA-114).
// Same execution ceiling as /results (REEA-391): the /search address runs the
// identical staged live-collection walk, so its ceiling must cover it too.
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/* /search?q= is a valid address for the canonical /results?q= page; it renders
   the same server-collection path so both addresses stay valid. */
export default function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  return <ResultsPage searchParams={searchParams} />;
}
