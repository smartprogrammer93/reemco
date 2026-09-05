import Link from "next/link";

/* Theme v1 §3.5: not-found gets the same care as the happy path. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default function NotFound() {
  return (
    <div className="text-center" style={{ padding: "var(--space-12) 0" }}>
      <h1 style={{ font: "var(--text-display)", color: "var(--color-ink)" }}>
        Page not found
      </h1>
      <p className="mt-2" style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
        The page you were looking for doesn&apos;t exist. Try one of these searches:
      </p>
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
  );
}
