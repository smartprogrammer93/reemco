"use client";

import { usePathname, useSearchParams } from "next/navigation";
import SearchForm from "@/components/SearchForm";

/** Compact search in the sticky header on results/product pages (v4: ≥44px
 *  controls). Echoes the active ?q so the query survives retry/loading. */
export default function HeaderSearch() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (pathname === "/") return null;
  const q = searchParams.get("q") ?? undefined;
  const c = searchParams.get("c") ?? undefined;
  return (
    /* REEA-75: min-w-0 + flex-1 instead of a fixed maxWidth so the form can
       shrink on narrow viewports; cap width from sm up via CSS. */
    <div className="min-w-0 flex-1 sm:max-w-[360px]">
      <SearchForm compact defaultValue={q} country={c} />
    </div>
  );
}
