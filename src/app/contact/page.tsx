import StaticPage from "@/components/StaticPage";

/* REEA-181 — single-screen contact page. overflow-wrap:anywhere keeps the
   email inside the gutter at 375px. */
export const metadata = {
  title: "Contact – Reemco",
  description: "Questions, corrections, or a retailer we should add — email us.",
};

export default function ContactPage() {
  return (
    <StaticPage title="Contact">
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        Questions, corrections, or a retailer we should add? Email us.
      </p>
      <p>
        <a
          href="mailto:support@reemco.example"
          className="focusable hover:underline"
          style={{ font: "var(--rc-text-body)", color: "var(--rc-primary)", overflowWrap: "anywhere" }}
        >
          support@reemco.example
        </a>
      </p>
      <div className="flex flex-col" style={{ gap: "var(--rc-space-2)" }}>
        <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          We aim to reply within one business day.
        </p>
        <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          Include the product name and the retailer you saw.
        </p>
      </div>
    </StaticPage>
  );
}
