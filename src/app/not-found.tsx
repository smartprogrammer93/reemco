import Link from "next/link";

/* Theme v1 §3.5: not-found gets the same care as the happy path. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default function NotFound() {
  return (
    <div className="text-center" style={{ padding: "var(--rc-space-12) 0" }}>
      <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
        Page not found
      </h1>
      <p className="mt-2" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        The page you were looking for doesn&apos;t exist. Try one of these searches:
      </p>
      <div className="flex flex-wrap justify-center gap-4" style={{ marginTop: "var(--rc-space-4)" }}>
        {EXAMPLES.map((q) => (
          <Link
            key={q}
            href={`/results?q=${encodeURIComponent(q)}`}
            className="hover:underline"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
          >
            {q}
          </Link>
        ))}
      </div>
    </div>
  );
}
