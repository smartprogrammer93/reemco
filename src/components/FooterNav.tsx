"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/* REEA-181: each footer label now lands on its own route (previously all
 * three pointed at "/"), and the anchor matching the current route carries
 * aria-current="page". Markup and styles are identical to the old inline
 * nav — only hrefs and aria-current change. Same usePathname pattern as
 * HeaderSearch; server-rendered on first paint, no loading flash. */
const LINKS = [
  { href: "/about", label: "About" },
  { href: "/privacy", label: "Privacy" },
  { href: "/contact", label: "Contact" },
];

export default function FooterNav() {
  const pathname = usePathname();
  return (
    <nav className="mt-1 flex gap-3" style={{ font: "var(--rc-text-small)" }} aria-label="Footer">
      {LINKS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className="hover:underline"
          style={{ color: "var(--rc-primary)" }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
