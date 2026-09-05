import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import HeaderSearch from "@/components/HeaderSearch";
import "./globals.css";

/* Theme v1 §6: Inter 400/500/600/700, display swap; fallback stack in --font-sans. */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reemco Price Compare",
  description: "Prices, coupons and stock, compared honestly across retailers.",
  // Static-export host (surge) cannot emit a Referrer-Policy response header;
  // the <meta name="referrer"> equivalent is honored by browsers. The canonical
  // header is set by src/proxy.ts when served from a server host (Vercel).
  other: { referrer: "strict-origin-when-cross-origin" },
};

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="font-bold lowercase" style={{ color: "var(--color-ink)", fontSize: size }}>
      reemco
    </span>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
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
            style={{ maxWidth: "var(--layout-max-w)" }}
          >
            <Link href="/" className="focusable shrink-0 rounded">
              <Wordmark />
            </Link>
            <HeaderSearch />
          </div>
        </header>
        <main className="flex-1">{children}</main>
        {/* §3.6 footer with affiliate disclosure */}
        <footer
          className="border-t"
          style={{
            background: "var(--color-surface-muted)",
            borderTopColor: "var(--color-border)",
          }}
        >
          <div
            className="mx-auto w-full px-6 py-6"
            style={{ maxWidth: "var(--layout-max-w)" }}
          >
            <Wordmark size={16} />
            <p
              className="mt-1"
              style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)" }}
            >
              Reemco earns affiliate commissions from some retailer links. This never affects the
              ranking you see — best effective price always wins.
            </p>
            <nav className="mt-1 flex gap-3" style={{ font: "var(--text-small)" }} aria-label="Footer">
              <Link href="/" className="hover:underline" style={{ color: "var(--color-primary)" }}>
                About
              </Link>
              <Link href="/" className="hover:underline" style={{ color: "var(--color-primary)" }}>
                Privacy
              </Link>
              <Link href="/" className="hover:underline" style={{ color: "var(--color-primary)" }}>
                Contact
              </Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
