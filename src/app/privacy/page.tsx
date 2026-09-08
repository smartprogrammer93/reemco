import StaticPage, { StaticSection } from "@/components/StaticPage";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* REEA-181 — plain-language privacy summary; copy is final per the accepted
   design spec. */
export const metadata = {
  title: "Privacy – Reemco",
  description: "What Reemco records, and why — in plain language.",
};

export default async function PrivacyPage() {
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return (
    <StaticPage title={t.privacyTitle}>
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.privacyLead}
      </p>
      <StaticSection label={t.privacyRecordLabel}>
        {t.privacyRecordBody}
      </StaticSection>
      <StaticSection label={t.privacyWhyLabel}>
        {t.privacyWhyBody}
      </StaticSection>
      <StaticSection label={t.privacyLeaveLabel}>
        {t.privacyLeaveBody}
      </StaticSection>
    </StaticPage>
  );
}
