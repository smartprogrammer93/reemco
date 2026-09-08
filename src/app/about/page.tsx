import StaticPage, { StaticSection } from "@/components/StaticPage";

/* REEA-181 — copy blocks are final per the accepted design spec; keep each
   page ≈ one screen at 375px. */
export const metadata = {
  title: "About – Reemco",
  description:
    "What Reemco compares, which retailers it covers, and how fresh its prices are.",
};

export default function AboutPage() {
  return (
    <StaticPage title="About Reemco">
      <StaticSection label="WHAT WE DO">
        Reemco is a price-comparison site for shopping in Kuwait. Search one product and
        see its price, stock, coupons and cheaper alternatives across retailers in one
        list.
      </StaticSection>
      <StaticSection label="WHO WE COMPARE">
        Xcite · Jarir · Eureka · Sultan Center · Blink · Lulu Hypermarket · Quadra Stores ·
        Next Store · PC Kuwait.
      </StaticSection>
      <StaticSection label="HOW FRESH PRICES ARE">
        Offers are fetched live from each retailer the moment you search, not from a stale
        snapshot. Every result shows when its price was collected.
      </StaticSection>
    </StaticPage>
  );
}
