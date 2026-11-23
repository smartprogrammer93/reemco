"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-1069 — the global header's menu control (REEA-1055 AC2: 44x44
 * labelled control). It opens a real navigation panel (About / How we compare
 * / Privacy / Contact); no decorative icon. Escape or an outside click closes
 * it, and the trigger carries aria-expanded/aria-controls.
 */
export default function HeaderMenu({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const links = [
    { href: "/about", label: t.footerAbout },
    { href: "/about", label: t.menuHowCompare },
    { href: "/privacy", label: t.footerPrivacy },
    { href: "/contact", label: t.footerContact },
  ];

  return (
    <div className="rc-menu" ref={rootRef}>
      <button
        type="button"
        className="rc-icon-btn focusable"
        aria-label={open ? t.menuClose : t.menuLabel}
        aria-expanded={open}
        aria-controls="rc-menu-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open ? (
        <nav id="rc-menu-panel" className="rc-menu-panel" aria-label={t.menuLabel}>
          {links.map((l) => (
            <Link key={`${l.href}-${l.label}`} href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
