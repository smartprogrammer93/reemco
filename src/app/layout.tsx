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
        <header className="site-header">
          <div
            className="mx-auto flex h-full w-full items-center justify-between px-6"
            style={{ maxWidth: "var(--layout-max-w)" }}
          >
            <Link href="/" className="focusable rounded">
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
