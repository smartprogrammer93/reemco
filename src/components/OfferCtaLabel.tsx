"use client";

import { useEffect, useState } from "react";
import { ageSeconds } from "@/lib/relative-time";
import { clientLocale, getStrings, localizedAge, type Locale } from "@/lib/i18n";

/**
 * REEA-930 scope 1 — freshness-anchored offer CTA label: "Checked 12s ago ·
 * Xcite" (AR "تم التحقق قبل 12ث · اكسترا"). The label is composed at render
 * time from the offer's own `collectedAt` — never a stored or bundled age —
 * and RE-TICKS on the client from the same stamp without any refetch: the
 * collection moment is fixed, only the clock moves. Offers without a usable
 * stamp fall back to the plain label passed by the caller (AC1) — never an
 * invented age.
 *
 * Hydration contract (REEA-283 clock discipline): the initial render uses the
 * `initialSeconds` the caller derived from the baked server clock
 * (renderStartMs), so the served HTML and the first client render agree;
 * only the post-hydration effect reads Date.now(). The interval re-settles on
 * every tick and React bails out when the computed second is unchanged, so a
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
  const [secs, setSecs] = useState(initialSeconds);
  const [lastInitial, setLastInitial] = useState(initialSeconds);
  // Guarded render-time adjustment (react.dev pattern, same as CountUpPrice):
  // a refreshed offer carries a new stamp — reset during render so the label
  // never shows a stale baked second.
  if (lastInitial !== initialSeconds) {
    setLastInitial(initialSeconds);
    setSecs(initialSeconds);
  }
  useEffect(() => {
    const tick = () => {
      const s = ageSeconds(collectedAt, Date.now());
      if (s != null) setSecs(s);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [collectedAt]);
  return <span className="tabular">{localizedAge(locale ?? clientLocale(), secs)}</span>;
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
  return (
    <>
      {t.ctaCheckedLead} <LiveAge collectedAt={collectedAt} initialSeconds={initialSeconds} locale={locale} />
      {" · "}
      <bdi>{merchant}</bdi>
    </>
  );
}
