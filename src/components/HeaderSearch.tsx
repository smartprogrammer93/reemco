"use client";

import { usePathname } from "next/navigation";
import SearchForm from "@/components/SearchForm";

/** Theme v1 §3.1: compact 40px search sits in the sticky header on results/product pages. */
export default function HeaderSearch() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <div className="w-full" style={{ maxWidth: 360 }}>
      <SearchForm compact />
    </div>
  );
}
