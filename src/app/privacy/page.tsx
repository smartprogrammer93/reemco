import StaticPage, { StaticSection } from "@/components/StaticPage";

/* REEA-181 — plain-language privacy summary; copy is final per the accepted
   design spec. */
export const metadata = {
  title: "Privacy – Reemco",
  description: "What Reemco records, and why — in plain language.",
};

export default function PrivacyPage() {
  return (
    <StaticPage title="Privacy">
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        In plain language: what Reemco records, and why.
      </p>
      <StaticSection label="WHAT WE RECORD">
        Which product was searched, which offers were opened, and which retailer link was
        clicked. Records are anonymous counts and click-outs — no names, no personal
        profiles.
      </StaticSection>
      <StaticSection label="WHY">
        It tells us which searches return good matches and where our results need fixing.
      </StaticSection>
      <StaticSection label="WHEN YOU LEAVE">
        Clicking through opens the retailer&apos;s own site. From that click on, the
        retailer&apos;s own privacy policy applies.
      </StaticSection>
    </StaticPage>
  );
}
