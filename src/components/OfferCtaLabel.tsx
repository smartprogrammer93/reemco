"use client";

import { useEffect, useState } from "react";
import { ageSeconds, localizedAgeFromStamp } from "@/lib/relative-time";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-930 scope 1 / REEA-1100 — freshness-anchored offer CTA label:
 * "Checked just now · Xcite" (AR "تم التحقق الآن · اكسترا"). The label is
 * composed at render time from the offer's own `collectedAt` — never a
 * stored or bundled age — and RE-TICKS on the client from the same stamp
 * without any refetch: the collection moment is fixed, only the clock moves.
 * Offers without a usable stamp fall back to the plain label passed by the
 * caller (AC1) — never an invented age.
 *
 * REEA-1100 — the age token goes through localizedAgeFromStamp (the same
 * localizedAgePair ladder ProductHero uses), so a sub-minute stamp reads
 * "just now"/"الآن" instead of a raw "0s ago", and Arabic gets its dual/
 * plural forms (`قبل دقيقتين`) with no English "s ago"/"m ago" suffix.
 * Missing/invalid stamps render the existing localized unknown copy rather
 * than fabricating a "just now".
 *
 * Hydration contract (REEA-283 clock discipline): the initial render uses the
 * `initialSeconds` the caller derived from the baked server clock
 * (renderStartMs), so the served HTML and the first client render agree;
 * only the post-hydration effect reads Date.now(). The interval re-settles on
 * every tick and React bails out when the computed text is unchanged, so a
 * quiet page costs no renders. The label sits on its own line with tabular
 * numerals, so a ticking digit changes no width around it (AC1 no-shift).
 *
 * The merchant name rides a bidi isolate (REEA-451 F6) so Latin retailer
 * names keep their order inside Arabic chrome; the "·" separator is the same
 * neutral separator the provenance chips use.
 */
export function LiveAge({
  collectedAt,
  initialSeconds,
  locale,
}: {
  collectedAt: string;
  initialSeconds: number;
  locale?: Locale;
}) {
  const localeResolved = locale ?? clientLocale();
  const t = getStrings(localeResolved);
  // The caller's baked second count is itself the reference clock: stamp +
  // initialSeconds is the moment the server measured, so SSR and hydration
  // land on the same localized bucket without a second clock read.
  const stampMs = Date.parse(collectedAt);
  const bakedNowMs = Number.isFinite(stampMs)
    ? stampMs + Math.max(0, initialSeconds) * 1000
    : Number.NaN;
  const bakedText =
    localizedAgeFromStamp(localeResolved, collectedAt, bakedNowMs) ?? t.dateUnknown;
  const [text, setText] = useState(bakedText);
  const [lastInitial, setLastInitial] = useState(initialSeconds);
  // Guarded render-time adjustment (react.dev pattern, same as CountUpPrice):
  // a refreshed offer carries a new stamp — reset during render so the label
  // never shows a stale baked age.
  if (lastInitial !== initialSeconds) {
    setLastInitial(initialSeconds);
    setText(bakedText);
  }
  useEffect(() => {
    const tick = () => {
      const s = ageSeconds(collectedAt, Date.now());
      if (s == null) return;
      const next =
        localizedAgeFromStamp(localeResolved, collectedAt, stampMs + s * 1000) ?? t.dateUnknown;
      setText(next);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [collectedAt, localeResolved, stampMs, t.dateUnknown]);
  return <span className="tabular">{text}</span>;
}

export default function OfferCtaLabel({
  merchant,
  collectedAt,
  initialSeconds,
  locale,
  fallback,
}: {
  merchant: string;
  /** ISO 8601 collection stamp of THIS offer's hop. */
  collectedAt?: string;
  /** Whole-second age derived from the caller's baked clock; null = no usable stamp. */
  initialSeconds: number | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /** Plain label rendered when no usable stamp exists (AC1 fallback). */
  fallback: React.ReactNode;
}) {
  if (collectedAt == null || initialSeconds == null) {
    return <>{fallback}</>;
  }
  const t = getStrings(locale ?? clientLocale());
  // REEA-1091 — the CTA anchors are inline-flex (.btn-primary/.btn-outline/
  // .r2-btn), so returning a fragment here makes "Checked", the age, " · " and
  // the merchant separate FLEX ITEMS: flex drops the whitespace-only text
  // nodes and trims the separator's edges, rendering "Checked4s ago·Xcite".
  // The label therefore ships as ONE flex item with normal inline flow inside
  // (.offer-cta-label), keeping the authored spaces around the age and the
  // separator ("Checked 4s ago · Xcite") while the anchor still owns the
  // button layout.
  return (
    <span className="offer-cta-label">
      {t.ctaCheckedLead} <LiveAge collectedAt={collectedAt} initialSeconds={initialSeconds} locale={locale} />
      {" · "}
      <bdi>{merchant}</bdi>
    </span>
  );
}
