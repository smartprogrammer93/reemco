import StaticPage from "@/components/StaticPage";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* REEA-181 — single-screen contact page. overflow-wrap:anywhere keeps the
   email inside the gutter at 375px. */
export const metadata = {
  title: "Contact – Reemco",
  description: "Questions, corrections, or a retailer we should add — email us.",
};

export default async function ContactPage() {
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return (
    <StaticPage title={t.contactTitle}>
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.contactLead}
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
          {t.contactReply}
        </p>
        <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {t.contactInclude}
        </p>
      </div>
    </StaticPage>
  );
}
