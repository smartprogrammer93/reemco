import Link from "next/link";
import SearchForm from "@/components/SearchForm";

/* Design v4 "Warm Signal": full-bleed espresso hero band, ivory display type,
   ONE amber underline accent under "best price", preset-query pills, trust
   caption below. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default function Home() {
  return (
    <>
      <section className="hero-band">
        <div
          className="mx-auto w-full px-6 text-center md:text-left"
          style={{ maxWidth: "calc(var(--rc-layout-max-w) - var(--rc-gutter) * 2)" }}
        >
          <h1 className="hero-title">
            Find the real <span className="hero-accent">best price</span>.
          </h1>
          <p className="hero-sub mt-3 max-w-xl mx-auto md:mx-0">
            Prices, coupons and stock, collected live from every retailer the moment you
            open a product — compared honestly, never from a stale snapshot.
          </p>
          <div className="mt-6">
            <SearchForm />
          </div>
          <div className="mt-4 flex flex-wrap justify-center md:justify-start gap-2">
            {EXAMPLES.map((q) => (
              <Link key={q} href={`/results?q=${encodeURIComponent(q)}`} className="query-pill">
                {q}
              </Link>
            ))}
          </div>
        </div>
      </section>
      <div className="mx-auto w-full px-6" style={{ maxWidth: "var(--rc-layout-max-w)" }}>
        <p className="mt-4" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          Live collection starts as soon as you pick a product — first offers usually land
          within about two seconds, and every price shows when it was collected and by whom.
        </p>
      </div>
    </>
  );
}
