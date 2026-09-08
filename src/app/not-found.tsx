import Link from "next/link";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* Theme v1 §3.5: not-found gets the same care as the happy path. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default async function NotFound() {
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return (
    <div className="text-center" style={{ padding: "var(--rc-space-12) 0" }}>
      <h1 style={{ font: "var(--rc-text-display)", color: "var(--rc-ink)" }}>
        {t.notFoundTitle}
      </h1>
      <p className="mt-2" style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.notFoundBody}
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
