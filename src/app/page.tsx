import Link from "next/link";
import SearchForm from "@/components/SearchForm";

/* Theme v1 §3.2: hero search on surface-muted; no fake content, no fake logos. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default function Home() {
  return (
    <section
      className="flex justify-center"
      style={{ background: "var(--color-surface-muted)", padding: "var(--space-12) 0" }}
    >
      <div className="w-full px-6" style={{ maxWidth: 640 }}>
        <h1 className="text-center" style={{ font: "var(--text-display)", color: "var(--color-ink)" }}>
          Find the real best price.
        </h1>
        <p
          className="text-center"
          style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)", marginTop: "var(--space-2)" }}
        >
          Prices, coupons and stock, compared honestly across retailers.
        </p>
        <div className="mt-6">
          <SearchForm />
        </div>
        <div className="flex flex-wrap justify-center gap-4" style={{ marginTop: "var(--space-4)" }}>
          {EXAMPLES.map((q) => (
            <Link
              key={q}
              href={`/results?q=${encodeURIComponent(q)}`}
              className="hover:underline"
              style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
            >
              {q}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
