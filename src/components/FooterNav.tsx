"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/* REEA-181: each footer label now lands on its own route (previously all
 * three pointed at "/"), and the anchor matching the current route carries
 * aria-current="page". Markup and styles are identical to the old inline
 * nav — only hrefs and aria-current change. Same usePathname pattern as
 * HeaderSearch; server-rendered on first paint, no loading flash.
 * REEA-279: the three labels + the nav aria-label ride the static EN/AR
 * table (footerAbout/footerPrivacy/footerContact/footerNav). */
const LINKS = [
  { href: "/about", key: "footerAbout" },
  { href: "/privacy", key: "footerPrivacy" },
  { href: "/contact", key: "footerContact" },
] as const;

export default function FooterNav({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  const pathname = usePathname();
  return (
    <nav className="mt-1 flex gap-3" style={{ font: "var(--rc-text-small)" }} aria-label={t.footerNav}>
      {LINKS.map(({ href, key }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className="hover:underline"
          style={{ color: "var(--rc-primary)" }}
        >
          {t[key]}
        </Link>
      ))}
    </nav>
  );
}
