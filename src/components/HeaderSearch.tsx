"use client";

import { usePathname } from "next/navigation";
import SearchForm from "@/components/SearchForm";

/** Theme v1 §3.1: compact 40px search sits in the sticky header on results/product pages. */
export default function HeaderSearch() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    /* REEA-75: min-w-0 + flex-1 instead of a fixed maxWidth so the form can
       shrink on narrow viewports; cap width from sm up via CSS. */
    <div className="min-w-0 flex-1 sm:max-w-[360px]">
      <SearchForm compact />
    </div>
  );
}
