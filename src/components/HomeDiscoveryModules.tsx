import Link from "next/link";
import Image from "next/image";
import { formatPrimaryPrice } from "@/lib/format";
import { isProxiedImageSrc, proxiedImageSrc } from "@/lib/image-proxy";
import ProxyRetryImage from "@/components/ProxyRetryImage";
import { localizedAgeFor } from "@/lib/relative-time";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import {
  HOME_DISCOVERY_COPY,
  type HomeCategory,
  type HomeDiscovery,
  type HomePriceDrop,
  type HomeRetailer,
} from "@/lib/home-discovery";

/**
 * REEA-1069 — Direction A "Shelf" home discovery modules (REEA-1055 §3, AC1).
 *
 * Data comes ONLY from the live per-query fan-out the home page starts
 * (`collectHomeDiscovery` over the same runs the chip pre-warm uses). There
 * is no bundled catalogue: the retailer strip is this load's own responder
 * truth, price-drop cards are offers that carried a real compare-at price,
 * categories are the live-collected counts, and the method band states the
 * live run's own provenance.
 *
 * Every module has an explicit loading / empty / no-response state. A calm
 * designed line replaces invented merchandise. Partial runs stay visible
 * with a neutral inline note instead of blanking the modules.
 */

function LiveDot({ live }: { live: boolean }) {
  return <span className={`dot-live${live ? "" : " is-down"}`} aria-hidden />;
}

function CalmLine({ title, note }: { title: string; note?: string }) {
  return (
    <div className="rc-module-empty">
      <span className="title">{title}</span>
      {note ? <span className="note">{note}</span> : null}
    </div>
  );
}

function RetailerStrip({
  module,
  locale,
}: {
  module: HomeDiscovery["retailerStrip"];
  locale: Locale;
}) {
  const copy = HOME_DISCOVERY_COPY[locale];
  const t = getStrings(locale);
  if (module.status === "no-response") return <CalmLine title={copy.noResponseModule} />;
  if (module.items.length === 0) return <CalmLine title={copy.emptyRetailer} />;
  // The live fan-out queries 23 adapters. The strip is a glanceable shelf,
  // not a directory: keep the eight coverage-order leaders and state how
  // many more were checked, so the module keeps its designed geometry and
  // still reports the run's own truth (never an invented retailer list).
  const shown = module.items.slice(0, 8);
  const rest = module.items.length - shown.length;
  return (
    <div className="rc-retailer-strip">
      {shown.map((r: HomeRetailer) => (
        <div className="rc-retailer" key={r.merchant}>
          <bdi className="logo lat">{r.merchant}</bdi>
          <LiveDot live={r.state === "live"} />
          <span className="rc-retailer-note">
            {r.state === "live" ? copy.liveLabel : copy.noResponseLabel}
          </span>
        </div>
      ))}
      {rest > 0 ? (
        <div className="rc-retailer rc-retailer-more">
          <span>{t.retailersMore.replace("{n}", String(rest))}</span>
        </div>
      ) : null}
    </div>
  );
}

function PriceDrops({
  module,
  locale,
  nowMs,
}: {
  module: HomeDiscovery["priceDrops"];
  locale: Locale;
  nowMs: number;
}) {
  const copy = HOME_DISCOVERY_COPY[locale];
  const t = getStrings(locale);
  if (module.status === "no-response") return <CalmLine title={copy.noResponseModule} />;
  if (module.items.length === 0) {
    return (
      <CalmLine
        title={copy.emptyPriceDrops}
        note={t.homeDropsEmptyNote}
      />
    );
  }
  return (
    <div className="rc-drop-grid">
      {module.items.map((d: HomePriceDrop) => {
        const price = formatPrimaryPrice(d.currentPrice, d.currency).label;
        const priceLead = locale === "ar" ? `${t.fromWord} ` : "";
        const struck = formatPrimaryPrice(d.savings.struckPrice, d.savings.currency).label;
        const saved = formatPrimaryPrice(d.savings.amount, d.savings.currency).label;
        const checked =
          d.checkedAtEpochMs != null ? localizedAgeFor(locale, d.checkedAtEpochMs, nowMs) : null;
        // REEA-1128 — the drop thumbnail follows the same proxied-source
        // policy as the results card (Shopify photos go through our origin).
        const thumb = proxiedImageSrc(d.image);
        return (
          <article className="rc-drop-card" key={`${d.productId}-${d.merchant}`}>
            <Link href={d.href} className="rc-drop-thumb" aria-label={d.title}>
              {thumb ? (
                isProxiedImageSrc(thumb) ? (
                  <ProxyRetryImage src={thumb} alt={`${d.title} — product image`} width={96} height={96} />
                ) : (
                  <Image
                    src={thumb}
                    alt={`${d.title} — product image`}
                    width={96}
                    height={96}
                    sizes="96px"
                    unoptimized
                    referrerPolicy="no-referrer"
                  />
                )
              ) : (
                <span className="rc-media-glyph" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} width={34} height={34}>
                    <path d="M3 9.5 5.5 4h13L21 9.5V20H3V9.5Z" />
                    <path d="M3 9.5h18M8.5 13.5h7" />
                  </svg>
                </span>
              )}
            </Link>
            <div>
              <Link href={d.href} className="name">
                <bdi>{d.title}</bdi>
              </Link>
              <div className="price tabular">
                {priceLead ? <span className="price-from">{priceLead}</span> : null}
                <bdi>{price}</bdi>
              </div>
              <div className="drop">
                <span aria-hidden>↓</span> <bdi>{saved}</bdi> {t.dropLower}
              </div>
              <div className="rc-drop-baseline">
                <s className="tabular"><bdi>{struck}</bdi></s>
                {" · "}
                <span>{fill(t.savingsBaseline, { x: d.savings.baseline.merchant })}</span>
              </div>
              <div className="rc-live-note rc-drop-checked">
                {checked ? `${t.homeChecked} ${checked}` : t.dateUnknown}
                {" · "}
                <bdi className="lat">{d.merchant}</bdi>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Categories({
  module,
  locale,
}: {
  module: HomeDiscovery["categories"];
  locale: Locale;
}) {
  const copy = HOME_DISCOVERY_COPY[locale];
  // REEA-1268 D-2 — this module is the browse taxonomy, not a merchandise
  // module: the eight `/c/<slug>` links stay available even when the home
  // fan-out could not answer, because each category page runs its own live
  // collection. Only the count badge is load-specific, and a 0 is hidden
  // rather than claimed.
  if (module.items.length === 0) return <CalmLine title={copy.emptyCategories} />;
  return (
    <div className="rc-cat-grid">
      {module.items.map((c: HomeCategory) => (
        <Link className="rc-cat" href={c.href} key={c.id}>
          <span>
            {c.label[locale]}
            {c.count > 0 ? <span className="rc-cat-count">{c.count}</span> : null}
          </span>
          <svg className="rc-icon-dir" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      ))}
    </div>
  );
}

function MethodBand({ discovery, locale }: { discovery: HomeDiscovery; locale: Locale }) {
  const copy = HOME_DISCOVERY_COPY[locale];
  const t = getStrings(locale);
  const band = discovery.methodBand;
  if (band.status === "no-response") return <CalmLine title={copy.noResponseModule} />;
  const provenance =
    band.provenance.collectedAtEpochMs != null
      ? localizedAgeFor(locale, band.provenance.collectedAtEpochMs)
      : band.provenance.collectedAt;
  return (
    <div className="rc-method-band">
      <div>
        <h3>{t.homeMethodTitle}</h3>
        <p>{copy.disclosure}</p>
        {provenance ? (
          <p className="rc-method-provenance">
            {copy.methodProvenance}
            {provenance !== "just now" && provenance !== "الآن" ? ` · ${provenance}` : ""}
          </p>
        ) : null}
      </div>
      <ul className="rc-trust-list">
        <li>
          <svg className="tick" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m4 12.5 5 5L20 6.5" />
          </svg>
          <span>{`${band.offers} ${copy.methodOffers}`}</span>
        </li>
        <li>
          <svg className="tick" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m4 12.5 5 5L20 6.5" />
          </svg>
          <span>{`${band.coupons} ${copy.methodCoupons}`}</span>
        </li>
        <li>
          <svg className="tick" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m4 12.5 5 5L20 6.5" />
          </svg>
          <span>{`${band.retailersAnswered}/${band.retailersQueried} ${copy.methodRetailers}`}</span>
        </li>
        <li>
          <svg className="tick" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m4 12.5 5 5L20 6.5" />
          </svg>
          <span>{t.trustAffiliate}</span>
        </li>
      </ul>
    </div>
  );
}

function ModuleSection({
  title,
  note,
  children,
  action,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rc-module">
      <div className="rc-module-head">
        <div>
          <h2>{title}</h2>
          {note ? <span className="rc-live-note">{note}</span> : null}
        </div>
        {action}
      </div>
      {children}
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
  const copy = HOME_DISCOVERY_COPY[locale];
  const t = getStrings(locale);
  // One baked render clock for every humanised timestamp on this page.
  // eslint-disable-next-line react-hooks/purity -- server component render clock.
  const nowMs = Date.now();
  const liveNote =
    data.collectedAtEpochMs != null ? localizedAgeFor(locale, data.collectedAtEpochMs, nowMs) : null;
  const answered = [...new Set(data.queries.flatMap((q) => q.responders.answered))];
  const noResponse = [...new Set(data.queries.flatMap((q) => q.responders.noResponse))];
  return (
    <div aria-busy={data.partial ? true : undefined}>
      <p className="rc-home-live">
        <span className="rc-pulse" aria-hidden />
        {`${copy.liveNote}${liveNote ? ` · ${liveNote}` : ""}`}
      </p>
      {data.partial ? (
        <p className="rc-partial rc-home-partial" role="status">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 7.8h.01" />
          </svg>
          <span>
            {t.homePartialNote}
            {answered.length > 0 ? (
              <>
                {" "}
                <bdi className="lat">{answered.slice(0, 4).join(" · ")}</bdi>
                {answered.length > 4 ? " +" + (answered.length - 4) : ""}
              </>
            ) : null}
            {noResponse.length > 0 ? (
              <>
                {" — "}
                <bdi className="lat">{noResponse.slice(0, 4).join(" · ")}</bdi>
                {noResponse.length > 4 ? " +" + (noResponse.length - 4) : ""}
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      <ModuleSection
        title={copy.retailerStripTitle}
        note={
          <>
            <span className="rc-pulse" aria-hidden />
            {liveNote ?? copy.liveLabel}
          </>
        }
      >
        <RetailerStrip module={data.retailerStrip} locale={locale} />
      </ModuleSection>
      <ModuleSection
        title={copy.priceDropsTitle}
        note={
          <>
            <span className="rc-pulse" aria-hidden />
            {t.homeDropsNote}
          </>
        }
        action={
          <Link href="/results?q=price%20drop" className="rc-live-note">
            {t.homeAllDrops}
          </Link>
        }
      >
        <PriceDrops module={data.priceDrops} locale={locale} nowMs={nowMs} />
      </ModuleSection>
      <ModuleSection title={copy.categoriesTitle}>
        <Categories module={data.categories} locale={locale} />
      </ModuleSection>
      <ModuleSection title={copy.methodTitle}>
        <MethodBand discovery={data} locale={locale} />
      </ModuleSection>
    </div>
  );
}

/** The streamed loading state: reserves real module geometry. */
export function HomeDiscoverySkeleton({ locale }: { locale: Locale }) {
  const copy = HOME_DISCOVERY_COPY[locale];
  return (
    <div aria-busy="true">
      <p className="rc-home-live">
        <span className="rc-pulse" aria-hidden />
        {`${copy.liveNote} · …`}
      </p>
      {[copy.retailerStripTitle, copy.priceDropsTitle, copy.categoriesTitle].map((title) => (
        <section className="rc-module" key={title}>
          <div className="rc-module-head">
            <h2>{title}</h2>
          </div>
          <div className="rc-drop-grid">
            {[0, 1, 2].map((i) => (
              <div className="rc-skeleton" key={i}>
                <div className="rc-sk rc-sk-line short" />
                <div className="rc-sk rc-sk-fill rc-sk-media" />
                <div className="rc-sk rc-sk-line" />
                <div className="rc-sk rc-sk-fill rc-sk-price" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
