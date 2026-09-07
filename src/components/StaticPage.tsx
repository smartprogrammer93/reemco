import type { ReactNode } from "react";

/**
 * REEA-181 shared shell for the static trust pages (/about, /privacy,
 * /contact) per the accepted design spec. Reuses the shipped hero/footer
 * wrapper (`mx-auto w-full px-6` at --rc-layout-max-w) with a 65ch reading
 * column that centers below the md breakpoint and goes flush-left above it —
 * the hero's own pattern. Title rides --rc-text-h2 (calm h2 scale, not the
 * hero display); blocks breathe on a 24px rhythm and close 48px above the
 * footer. Existing --rc-* tokens only, dark mode swaps via semantics.
 */
export default function StaticPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full px-6" style={{ maxWidth: "var(--rc-layout-max-w)" }}>
      <div
        className="mx-auto max-w-[65ch] md:mx-0"
        style={{ paddingBottom: "var(--rc-space-12)" }}
      >
        <h1
          className="text-center md:text-left"
          style={{
            font: "var(--rc-text-h2)",
            color: "var(--rc-ink)",
            marginTop: "var(--rc-space-8)",
            marginBottom: "var(--rc-space-6)",
          }}
        >
          {title}
        </h1>
        <div className="flex flex-col" style={{ gap: "var(--rc-space-6)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Label + paragraph pair. The uppercase micro-label binds to its paragraph
 *  on an 8px proximity gap; blocks themselves are separated by spacing only,
 *  no hairline rules. */
export function StaticSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <p
        style={{
          font: "var(--rc-text-label)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--rc-muted)",
          marginBottom: "var(--rc-space-2)",
        }}
      >
        {label}
      </p>
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>{children}</p>
    </section>
  );
}
