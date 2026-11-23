import Link from "next/link";
import Image from "next/image";
import { COVERAGE_ORDER, type LiveSearchResult } from "@/lib/collect/coverage";
import { formatCountryPrice } from "@/lib/format";
import { checkedAgeLabel, clientLocale, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-1069 — Direction A home discovery modules (REEA-1055 §3, AC1).
 *
 * Every module here is populated from the LIVE per-query fan-out the page
 * starts at render time (`collectLiveResultsStaged` — the same collection the
 * results page runs). Nothing is a bundled catalogue: the retailer strip is
 * the run's own per-retailer truth, the price-drop cards are offers the run
 * actually collected with a real was-price, and an empty run renders the calm
 * designed empty line instead of invented merchandise.
 *
 * Loading, empty and no-response states are first-class (design states sheet):
 * each module has its own skeleton fallback and a calm empty/no-response line.
 */

export function ModuleSkeleton({ label, locale }: { label: string; locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <div className="rc-module" aria-busy="true" aria-label={label}>
      <div className="mx-auto w-full" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}>
        <div className="rc-module-head">
          <h2 style={{ font: "var(--rc-text-h2)", color: "var(--rc-ink)" }}>{label}</h2>
          <span className="rc-live-note">{t.homeModuleLoading}</span>
        </div>
        <div className="rc-drop-grid">
          <div className="rc-skeleton">
            <div className="rc-sk rc-sk-line short" />
            <div className="rc-sk rc-sk-fill rc-sk-media" />
            <div className="rc-sk rc-sk-line" />
            <div className="rc-sk rc-sk-fill rc-sk-price" />
          </div>
        </div>
      </div>
    </div>
  );
}

function sortNotes(notes: LiveSearchResult["notes"]): LiveSearchResult["notes"] {
  return [...notes].sort((a, b) => {
    const ia = COVERAGE_ORDER.indexOf(a.merchant as (typeof COVERAGE_ORDER)[number]);
    const ib = COVERAGE_ORDER.indexOf(b.merchant as (typeof COVERAGE_ORDER)[number]);
    return (ia < 0 ? COVERAGE_ORDER.length : ia) - (ib < 0 ? COVERAGE_ORDER.length : ib);
  });
}

export async function RetailerStrip({
  live,
  locale,
}: {
  live: Promise<LiveSearchResult | null>;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const snap = await live;
  const notes = snap ? sortNotes(snap.notes) : [];
  return (
    <section className="rc-module" aria-label={t.homeRetailersTitle}>
      <div className="mx-auto w-full" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}>
        <div className="rc-module-head">
          <h2>{t.homeRetailersTitle}</h2>
          <span className="rc-live-note">
            <span className="rc-pulse" aria-hidden />
            {snap ? t.homeLiveNote.replace("{age}", t.justNow) : t.homeModuleNoResponse}
          </span>
        </div>
        {notes.length === 0 ? (
          <div className="rc-module-empty">
            <span className="title">{t.homeModuleNoResponse}</span>
            <span className="note">{t.homeDropsEmptyNote}</span>
          </div>
        ) : (
          <div className="rc-retailer-strip">
            {notes.slice(0, 8).map((n) => {
              const down = typeof n.error === "string";
              return (
                <div className="rc-retailer" key={n.merchant}>
                  <span className="logo lat">{n.merchant}</span>
                  <span className={`dot-live${down ? " is-down" : ""}`} aria-hidden />
                  <span className="rc-retailer-note">{down ? t.retailerNoResponse : t.retailerLive}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export async function PriceDrops({
  live,
  locale,
}: {
  live: Promise<LiveSearchResult | null>;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  const snap = await live;
  // eslint-disable-next-line react-hooks/purity -- server component render clock; one read per request.
  const nowMs = Date.now();
  const drops: {
    productId: string;
    title: string;
    image?: string;
    price: number;
    currency: string;
    wasPrice: number;
    merchant: string;
    collectedAt?: string;
  }[] = [];
  for (const p of snap?.products ?? []) {
    for (const o of p.offers) {
      if (!o.inStock || o.wasPrice == null || o.wasPrice <= o.price) continue;
      drops.push({
        productId: p.productId,
        title: p.title,
        image: p.image ?? o.image,
        price: o.price,
        currency: o.currency,
        wasPrice: o.wasPrice,
        merchant: o.merchant,
        collectedAt: o.collectedAt,
      });
    }
  }
  drops.sort((a, b) => b.wasPrice - b.price - (a.wasPrice - a.price));
  const top = drops.slice(0, 3);
  return (
    <section className="rc-module" aria-label={t.homeDropsTitle}>
      <div className="mx-auto w-full" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}>
        <div className="rc-module-head">
          <div>
            <h2>{t.homeDropsTitle}</h2>
            <span className="rc-live-note">
              <span className="rc-pulse" aria-hidden />
              {t.homeDropsNote}
            </span>
          </div>
          <Link href="/results?q=price%20drop" className="rc-live-note">
            {t.homeAllDrops}
          </Link>
        </div>
        {top.length === 0 ? (
          <div className="rc-module-empty">
            <span className="title">{t.homeDropsEmptyTitle}</span>
            <span className="note">{t.homeDropsEmptyNote}</span>
          </div>
        ) : (
          <div className="rc-drop-grid">
            {top.map((d) => {
              const price = formatCountryPrice(d.price, d.currency, null).primary;
              const drop = formatCountryPrice(d.wasPrice - d.price, d.currency, null).primary;
              const age =
                d.collectedAt && Number.isFinite(Date.parse(d.collectedAt))
                  ? Math.max(0, Math.floor((nowMs - Date.parse(d.collectedAt)) / 1000))
                  : null;
              return (
                <article className="rc-drop-card" key={`${d.productId}-${d.merchant}`}>
                  <Link href={`/product/${encodeURIComponent(d.productId)}`} className="rc-drop-thumb">
                    {d.image ? (
                      <Image src={d.image} alt={`${d.title} — product image`} width={96} height={96} unoptimized />
                    ) : null}
                  </Link>
                  <div>
                    <Link href={`/product/${encodeURIComponent(d.productId)}`} className="name" style={{ color: "var(--rc-ink)" }}>
                      <bdi>{d.title}</bdi>
                    </Link>
                    <div className="price tabular">
                      <bdi>{price}</bdi>
                    </div>
                    <div className="drop">
                      ↓ <bdi>{drop}</bdi> {t.dropLower}
                    </div>
                    <div className="rc-live-note" style={{ marginBlockStart: 6 }}>
                      {age == null ? t.dateUnknown : `${t.homeChecked} ${checkedAgeLabel(locale ?? clientLocale(), age)}`}
                      {" · "}
                      <bdi>{d.merchant}</bdi>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

const CATEGORY_QUERIES = [
  { key: "catPhones", query: "smartphone" },
  { key: "catLaptops", query: "laptop" },
  { key: "catHomeKitchen", query: "kitchen" },
  { key: "catAudio", query: "headphones" },
] as const;

export function CategoryGrid({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <section className="rc-module" aria-label={t.homeCategoriesTitle}>
      <div className="mx-auto w-full" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}>
        <div className="rc-module-head">
          <h2>{t.homeCategoriesTitle}</h2>
        </div>
        <div className="rc-cat-grid">
          {CATEGORY_QUERIES.map((c) => (
            <Link className="rc-cat" href={`/results?q=${encodeURIComponent(c.query)}`} key={c.key}>
              <span>{t[c.key]}</span>
              <svg className="rc-icon-dir" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MethodBand({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <section className="rc-module" aria-label={t.homeMethodTitle}>
      <div className="mx-auto w-full" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}>
        <div className="rc-method-band">
          <div>
            <h3>{t.homeMethodTitle}</h3>
            <p>{t.homeMethodBody}</p>
          </div>
          <ul className="rc-trust-list">
            {[t.trustBest, t.trustCoupons, t.trustProvenance, t.trustAffiliate].map((line) => (
              <li key={line}>
                <svg className="tick" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m4 12.5 5 5L20 6.5" />
                </svg>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
