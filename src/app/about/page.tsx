import StaticPage, { StaticSection } from "@/components/StaticPage";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* REEA-181 — copy blocks are final per the accepted design spec; keep each
   page ≈ one screen at 375px. */
export const metadata = {
  title: "About – Reemco",
  description:
    "What Reemco compares, which retailers it covers, and how fresh its prices are.",
};

export default async function AboutPage() {
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return (
    <StaticPage title={t.aboutTitle}>
      <StaticSection label={t.aboutWhatLabel}>
        {t.aboutWhatBody}
      </StaticSection>
      <StaticSection label={t.aboutWhoLabel}>
        {t.aboutWhoBody}
      </StaticSection>
      <StaticSection label={t.aboutFreshLabel}>
        {t.aboutFreshBody}
      </StaticSection>
    </StaticPage>
  );
}
