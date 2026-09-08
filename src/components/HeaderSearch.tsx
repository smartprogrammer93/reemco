"use client";

import { usePathname, useSearchParams } from "next/navigation";
import SearchForm from "@/components/SearchForm";
import type { Locale } from "@/lib/i18n";

/** Compact search in the sticky header on results/product pages (v4: ≥44px
 *  controls). Echoes the active ?q so the query survives retry/loading.
 *  REEA-279: the shell-resolved locale rides through to the form chrome. */
export default function HeaderSearch({ locale }: { locale?: Locale }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (pathname === "/") return null;
  const q = searchParams.get("q") ?? undefined;
  const c = searchParams.get("c") ?? undefined;
  const oos = searchParams.get("oos") ?? undefined;
  return (
    /* REEA-75: min-w-0 + flex-1 instead of a fixed maxWidth so the form can
       shrink on narrow viewports; cap width from sm up via CSS. */
    <div className="min-w-0 flex-1 sm:max-w-[360px]">
      <SearchForm compact defaultValue={q} country={c} oos={oos} locale={locale} />
    </div>
  );
}
