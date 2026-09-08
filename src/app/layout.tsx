import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import HeaderSearch from "@/components/HeaderSearch";
import FooterNav from "@/components/FooterNav";
import LocaleToggle from "@/components/LocaleToggle";
import { getStrings, localeDir, resolveRequestLocale } from "@/lib/i18n";
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

export const metadata: Metadata = {
  title: "Reemco Price Compare",
  description: "Prices, coupons and stock, compared honestly across retailers.",
  // Static-export builds cannot emit a Referrer-Policy response header;
  // the <meta name="referrer"> equivalent is honored by browsers. The canonical
  // header is set by src/proxy.ts when served from a server host (Vercel).
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
  // then the coarse Accept-Language hint, then "en" — so the served HTML
  // carries the right lang/dir and chrome strings on first paint, with no
  // client-side flip and no hydration mismatch. The request-time reads fall
  // back silently on the static-export host (same guard as /results).
  const locale = await resolveRequestLocale();
  const dir = localeDir(locale);
  const t = getStrings(locale);
  return (
    <html
      lang={locale}
      dir={dir}
      className={`${inter.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* REEA-42 interim F2 control for the static-export host (Surge): Surge
            cannot emit response headers, so the header CSP from src/proxy.ts
            never runs there. This <meta http-equiv> policy is the static-host
            fallback (React hoists it into <head>).
            - Browsers ignore CSP-Report-Only in <meta>, so this ships as an
              enforce-mode policy tuned to what the static bundle actually uses
              (inline Next bootstrap scripts => 'unsafe-inline' in script-src;
              no per-request nonces exist on a static host).
            - Kept compatible with the header CSP so both can coexist once the
              Vercel server-render deploy (VERCEL_TOKEN) serves the canonical
              header policy.
            - Remove this fallback when the server-render host is live and
              curl -I shows CSP-Report-Only + nosniff + Referrer-Policy. */}
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests"
        />
        <header className="site-header">
          <div
            className="mx-auto flex h-full w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-2 sm:flex-nowrap sm:py-0"
            style={{ maxWidth: "var(--rc-layout-max-w)" }}
          >
            <Link href="/" className="focusable shrink-0 rounded">
              <Wordmark />
            </Link>
            <Suspense fallback={null}>
              <HeaderSearch locale={locale} />
            </Suspense>
            {/* REEA-279: EN/AR toggle, always visible (HeaderSearch hides
                itself on "/"). Small text button — visual polish can ride a
                Graphic Designer pass later; the control itself is final. */}
            <LocaleToggle locale={locale} />
          </div>
        </header>
        <main className="flex-1">{children}</main>
        {/* §3.6 footer with affiliate disclosure */}
        <footer
          className="border-t"
          style={{
            background: "var(--rc-canvas)",
            borderTopColor: "var(--rc-line)",
          }}
        >
          <div
            className="mx-auto w-full px-6 py-6"
            style={{ maxWidth: "var(--rc-layout-max-w)" }}
          >
            <Wordmark size={16} />
            <p
              className="mt-1"
              style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}
            >
              {t.footerDisclosure}
            </p>
            {/* REEA-181: each label links to its own page now (was: three
                copies of href="/"). Markup moved to FooterNav so the active
                route can carry aria-current="page". */}
            <FooterNav locale={locale} />
          </div>
        </footer>
      </body>
    </html>
  );
}
