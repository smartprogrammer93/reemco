"use client";

import { useSearchParams } from "next/navigation";
import SearchForm from "@/components/SearchForm";
import type { Locale } from "@/lib/i18n";

/** Direction A global header search: present on every surface, including the
 *  home page (the design's global header carries it). Echoes the active ?q so
 *  the query survives retry/loading. REEA-279: the shell-resolved locale rides
 *  through to the form chrome. */
export default function HeaderSearch({ locale }: { locale?: Locale }) {
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? undefined;
  const c = searchParams.get("c") ?? undefined;
  const oos = searchParams.get("oos") ?? undefined;
  return <SearchForm variant="header" defaultValue={q} country={c} oos={oos} locale={locale} />;
}
