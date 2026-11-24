import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Noto_Sans_Arabic, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import HeaderSearch from "@/components/HeaderSearch";
import HeaderMenu from "@/components/HeaderMenu";
import FooterNav from "@/components/FooterNav";
import LocaleToggle from "@/components/LocaleToggle";
import ThemeToggle from "@/components/ThemeToggle";
import { getStrings, localeDir } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";
import { resolveRequestTheme } from "@/lib/theme-server";
import "./globals.css";

/* Theme v1 §6: Inter 400/500/600/700, display swap; fallback stack in --rc-font-body. */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

/* Theme v2 (REEA-90 C7, plan §2.2): Space Grotesk 600/700 for display/headers. */
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
});

/* REEA-1069 — Direction A Arabic is designed, not a mirrored fallback
 * (REEA-1055 RTL checklist §B: Noto Sans Arabic 400/600/700). Loaded through
 * next/font so the AR chrome ships the same self-hosted font path as EN. */
const notoArabic = Noto_Sans_Arabic({
  variable: "--font-noto-arabic",
  subsets: ["arabic"],
  weight: ["400", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reemco Price Compare",
  description: "Prices, coupons and stock, compared honestly across retailers.",
  other: { referrer: "strict-origin-when-cross-origin" },
};

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="font-bold lowercase" style={{ color: "var(--rc-ink)", fontSize: size }}>
      reemco
    </span>
  );
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // REEA-279: locale comes from the request itself — rc_locale cookie first,
  // then the coarse Accept-Language hint, then the Arabic-script query text
  // forwarded through the request, then "en". The served HTML carries the
  // right lang/dir and chrome strings on first paint, with no client-side
  // flip and no hydration mismatch.
  const locale = await resolveRequestLocale();
  // REEA-1159: the shopper's explicit theme choice rides the rc_theme cookie
  // and is resolved HERE, on the server, so the first paint already carries
  // data-theme="light|dark" on <html> — no flash of the wrong theme and no
  // inline bootstrap script to nonce under the REEA-1088 CSP path. No cookie
  // means no attribute: the shipped @media (prefers-color-scheme: dark) rules
  // keep following the OS, exactly as before this change.
  const theme = await resolveRequestTheme();
  const dir = localeDir(locale);
  const t = getStrings(locale);
  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={theme ?? undefined}
      className={`${inter.variable} ${spaceGrotesk.variable} ${notoArabic.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* REEA-42 interim F2 control for the STATIC-EXPORT host only (Surge):
            Surge cannot emit response headers, so the header CSP from
            src/proxy.ts never runs there. This <meta http-equiv> policy is the
            static-host fallback (React hoists it into <head>).
            REEA-1088: it is now gated on STATIC_EXPORT === "1" — on the live
            server-render hosts (self-hosted box / Vercel) the proxy header
            already ships the strict nonce policy, and a second `'unsafe-inline'`
            script-src meta would only WEAKEN it (a meta policy is enforced
            alongside the header; the intersection is what the browser applies,
            so keeping this one would re-admit every inline script).
            - Browsers ignore CSP-Report-Only in <meta>, so this ships as an
              enforce-mode policy tuned to what the static bundle actually uses
              (inline Next bootstrap scripts => 'unsafe-inline' in script-src;
              no per-request nonces exist on a static host).
            - Keep it compatible with the header policy so a static snapshot
              behaves like the live host for everything else. */}
        {process.env.STATIC_EXPORT === "1" && (
          <meta
            httpEquiv="Content-Security-Policy"
            content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests"
          />
        )}
        {/* REEA-1069 — Direction A global header: at 375 this is TWO rows
            (brand + labelled language/menu controls, then a full-width search
            row with a ≥200px input); at ≥641 it is one 64px row. Every
            control is 44x44. */}
        <header className="site-header">
          <div className="rc-header-inner">
            <Link href="/" className="rc-brand focusable" aria-label={t.brandHomeAria}>
              <span className="rc-wordmark lat">
                reemco<span className="dot">.</span>
              </span>
            </Link>
            <Suspense fallback={null}>
              <HeaderSearch locale={locale} />
            </Suspense>
            <div className="rc-header-actions">
              <LocaleToggle locale={locale} />
              <ThemeToggle locale={locale} initialTheme={theme} />
              <HeaderMenu locale={locale} />
            </div>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        {/* Direction A footer / trust band: affiliate disclosure EN/AR, method
            link, contact, market/currency line, 44px link targets at 375. */}
        <footer className="rc-footer">
          <div
            className="mx-auto w-full"
            style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}
          >
            <div className="rc-footer-grid">
              <div>
                <span className="rc-wordmark lat">
                  reemco<span className="dot">.</span>
                </span>
                <p className="rc-disclosure" style={{ marginBlockStart: "var(--rc-space-3)" }}>
                  {t.footerDisclosure}
                </p>
              </div>
              <div>
                <nav className="rc-footer-links" aria-label={t.footerNav}>
                  <Link href="/about">{t.menuHowCompare}</Link>
                </nav>
                <div style={{ marginBlockStart: "var(--rc-space-2)" }}>
                  <FooterNav locale={locale} />
                </div>
                <p className="rc-market-line">{t.marketLine}</p>
              </div>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
