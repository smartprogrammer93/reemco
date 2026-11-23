import Link from "next/link";
import Image from "next/image";
import { formatPrimaryPrice } from "@/lib/format";
import { localizedAgeFor } from "@/lib/relative-time";
import { getStrings, type Locale } from "@/lib/i18n";
import {
  HOME_DISCOVERY_COPY,
  type HomeCategory,
  type HomeDiscovery,
  type HomePriceDrop,
  type HomeRetailer,
} from "@/lib/home-discovery";

/**
 * REEA-1070 — the server half of the Direction A home discovery modules.
 *
 * This component renders the LIVE data contract from lib/home-discovery.ts
 * (retailer strip, price drops, categories, method band) with the existing
 * token vocabulary so the modules are real on the server path today. The
 * Frontend Engineer owns the final visual pass on REEA-1069; the data and the
 * loading/empty/no-response states are the stable contract this task ships.
 */

const sectionStyle: React.CSSProperties = {
  paddingBlock: "var(--rc-space-8)",
  borderTop: "1px solid var(--rc-line)",
};

const headingStyle: React.CSSProperties = {
  font: "var(--rc-text-h2)",
  color: "var(--rc-ink)",
};

const metaStyle: React.CSSProperties = {
  font: "var(--rc-text-small)",
  color: "var(--rc-muted)",
};

const calmStyle: React.CSSProperties = {
  ...metaStyle,
  paddingBlock: "var(--rc-space-3)",
};

function CalmLine({ children }: { children: React.ReactNode }) {
  return <p style={calmStyle}>{children}</p>;
}

function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: live ? "var(--rc-savings)" : "var(--rc-muted)",
        flex: "none",
      }}
    />
  );
}

function RetailerStrip({ module, copy }: { module: HomeDiscovery["retailerStrip"]; copy: (typeof HOME_DISCOVERY_COPY)["en"] }) {
  if (module.status === "no-response") {
    return <CalmLine>{copy.noResponseModule}</CalmLine>;
  }
  if (module.items.length === 0) return <CalmLine>{copy.emptyRetailer}</CalmLine>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--rc-space-2)" }}>
      {module.items.map((r: HomeRetailer) => (
        <span
          key={r.merchant}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
            paddingInline: 14,
            background: "var(--rc-surface)",
            border: "1px solid var(--rc-line)",
            borderRadius: "var(--rc-radius-control)",
            font: "var(--rc-text-label)",
            color: "var(--rc-ink)",
          }}
        >
          <LiveDot live={r.state === "live"} />
          <span style={{ fontWeight: 700 }}>{r.merchant}</span>
          <span style={{ color: "var(--rc-muted)", fontWeight: 400 }}>
            {r.state === "live" ? `${copy.liveLabel} · ${r.offers}` : copy.noResponseLabel}
          </span>
        </span>
      ))}
    </div>
  );
}

function PriceDropCard({ drop, locale }: { drop: HomePriceDrop; locale: Locale }) {
  const price = formatPrimaryPrice(drop.currentPrice, drop.currency).label;
  const struck = formatPrimaryPrice(drop.savings.struckPrice, drop.savings.currency).label;
  const saved = formatPrimaryPrice(drop.savings.amount, drop.savings.currency).label;
  const checked =
    drop.checkedAtEpochMs != null
      ? localizedAgeFor(locale, drop.checkedAtEpochMs)
      : null;
  const t = getStrings(locale);
  return (
    <Link
      href={drop.href}
      style={{
        display: "grid",
        gridTemplateColumns: "96px minmax(0,1fr)",
        gap: "var(--rc-space-3)",
        alignItems: "start",
        padding: "var(--rc-space-3)",
        background: "var(--rc-surface)",
        border: "1px solid var(--rc-line)",
        borderRadius: "var(--rc-radius-card)",
        color: "inherit",
        textDecoration: "none",
      }}
    >
      <span
        style={{
          display: "block",
          width: 96,
          height: 96,
          border: "1px solid var(--rc-line)",
          borderRadius: "var(--rc-radius-control)",
          background: "var(--rc-canvas)",
          overflow: "hidden",
        }}
      >
        {drop.image ? (
          <Image
            src={drop.image}
            alt=""
            width={96}
            height={96}
            sizes="96px"
            unoptimized
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : null}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", font: "var(--rc-text-title)", color: "var(--rc-ink)" }}>
          {drop.title}
        </span>
        <span style={{ display: "block", marginTop: 6, font: "var(--rc-text-price)", color: "var(--rc-ink)" }}>
          {price}
        </span>
        <span style={{ display: "block", marginTop: 4, font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          <s>{struck}</s>{" "}
          <span style={{ color: "var(--rc-savings)", fontWeight: 600 }}>
            {`${t.saveLead} ${saved}`}
          </span>
        </span>
        <span style={{ display: "block", marginTop: 4, font: "var(--rc-text-label)", color: "var(--rc-muted)" }}>
          {`${drop.savings.baseline.merchant} · ${checked ?? ""}`}
        </span>
      </span>
    </Link>
  );
}

function PriceDrops({ module, locale, copy }: { module: HomeDiscovery["priceDrops"]; locale: Locale; copy: (typeof HOME_DISCOVERY_COPY)["en"] }) {
  if (module.status === "no-response") return <CalmLine>{copy.noResponseModule}</CalmLine>;
  if (module.items.length === 0) return <CalmLine>{copy.emptyPriceDrops}</CalmLine>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--rc-space-3)" }}>
      {module.items.map((d) => (
        <PriceDropCard key={`${d.productId}-${d.merchant}`} drop={d} locale={locale} />
      ))}
    </div>
  );
}

function Categories({ module, locale, copy }: { module: HomeDiscovery["categories"]; locale: Locale; copy: (typeof HOME_DISCOVERY_COPY)["en"] }) {
  if (module.status === "no-response") return <CalmLine>{copy.noResponseModule}</CalmLine>;
  if (module.items.length === 0) return <CalmLine>{copy.emptyCategories}</CalmLine>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--rc-space-2)" }}>
      {module.items.map((c: HomeCategory) => (
        <Link
          key={c.id}
          href={c.href}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: 56,
            paddingInline: 16,
            background: "var(--rc-surface)",
            border: "1px solid var(--rc-line)",
            borderRadius: "var(--rc-radius-control)",
            font: "var(--rc-text-title)",
            color: "var(--rc-ink)",
            textDecoration: "none",
          }}
        >
          <span>{c.label[locale]}</span>
          <span style={{ font: "var(--rc-text-label)", color: "var(--rc-muted)" }}>{c.count}</span>
        </Link>
      ))}
    </div>
  );
}

function MethodBand({ discovery, copy }: { discovery: HomeDiscovery; copy: (typeof HOME_DISCOVERY_COPY)["en"] }) {
  const band = discovery.methodBand;
  if (band.status === "no-response") return <CalmLine>{copy.noResponseModule}</CalmLine>;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--rc-space-4)",
        padding: "var(--rc-space-4)",
        background: "var(--rc-canvas)",
        border: "1px solid var(--rc-line)",
        borderRadius: "var(--rc-radius-card)",
      }}
    >
      <div>
        <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>{copy.disclosure}</p>
        <p style={{ ...metaStyle, marginTop: "var(--rc-space-2)" }}>
          {`${band.queries} queries · ${band.provenance.collectedAt ?? ""}`}
        </p>
      </div>
      <ul style={{ display: "grid", gap: 8, font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}>
        <li>{`${band.offers} ${copy.methodOffers}`}</li>
        <li>{`${band.coupons} ${copy.methodCoupons}`}</li>
        <li>{`${band.retailersAnswered}/${band.retailersQueried} ${copy.methodRetailers}`}</li>
      </ul>
    </div>
  );
}

function ModuleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>{title}</h2>
      <div style={{ marginTop: "var(--rc-space-3)" }}>{children}</div>
    </section>
  );
}

export default async function HomeDiscoveryModules({
  discovery,
  locale,
}: {
  discovery: Promise<HomeDiscovery>;
  locale: Locale;
}) {
  const data = await discovery;
  const copy = HOME_DISCOVERY_COPY[locale === "ar" ? "ar" : "en"];
  const liveNote =
    data.collectedAtEpochMs != null
      ? localizedAgeFor(locale, data.collectedAtEpochMs)
      : null;
  return (
    <div aria-busy={data.partial ? true : undefined}>
      {liveNote ? (
        <p style={{ ...metaStyle, marginTop: "var(--rc-space-4)" }}>
          <LiveDot live /> {`${copy.liveNote} · ${liveNote}`}
        </p>
      ) : null}
      <ModuleSection title={copy.retailerStripTitle}>
        <RetailerStrip module={data.retailerStrip} copy={copy} />
      </ModuleSection>
      <ModuleSection title={copy.priceDropsTitle}>
        <PriceDrops module={data.priceDrops} locale={locale} copy={copy} />
      </ModuleSection>
      <ModuleSection title={copy.categoriesTitle}>
        <Categories module={data.categories} locale={locale} copy={copy} />
      </ModuleSection>
      <ModuleSection title={copy.methodTitle}>
        <MethodBand discovery={data} copy={copy} />
      </ModuleSection>
    </div>
  );
}

/** REEA-1070 — the streamed loading state (reserves real module geometry). */
export function HomeDiscoverySkeleton({ locale }: { locale: Locale }) {
  const copy = HOME_DISCOVERY_COPY[locale === "ar" ? "ar" : "en"];
  const ghost: React.CSSProperties = {
    background: "var(--rc-skeleton-bg)",
    border: "1px solid var(--rc-line)",
    borderRadius: "var(--rc-radius-card)",
    minHeight: 96,
  };
  return (
    <div aria-busy="true" style={{ marginTop: "var(--rc-space-4)" }}>
      <p style={{ ...metaStyle, marginBottom: "var(--rc-space-3)" }}>{copy.liveNote} · …</p>
      {[copy.retailerStripTitle, copy.priceDropsTitle, copy.categoriesTitle].map((title) => (
        <section key={title} style={sectionStyle}>
          <h2 style={headingStyle}>{title}</h2>
          <div
            style={{
              marginTop: "var(--rc-space-3)",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "var(--rc-space-2)",
            }}
          >
            <span style={ghost} />
            <span style={ghost} />
            <span style={ghost} />
          </div>
        </section>
      ))}
    </div>
  );
}
