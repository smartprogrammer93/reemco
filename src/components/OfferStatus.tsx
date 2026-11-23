import { getStrings, type Locale } from "@/lib/i18n";
import type { OfferStatus } from "@/lib/offer-status";

/**
 * REEA-1069 — Direction A status system (REEA-1055 spec §3 / token diff §2).
 * ONE neutral container for Verified / Needs verification / Stale; state is
 * carried by icon SHAPE + label + tooltip, never colour alone. 22px token,
 * 14px icon, 12px 600 label, 8px inline padding, 6px radius.
 *
 * One instance per offer. Never on a variant chip (the variant chip's own
 * warning state is a price claim, not a verification status).
 */

function VerifiedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 4.5 6v6c0 4.4 3.1 7.6 7.5 9 4.4-1.4 7.5-4.6 7.5-9V6L12 3Z" />
      <path d="m8.5 12 2.4 2.4 4.6-4.8" />
    </svg>
  );
}

function UnverifiedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" strokeDasharray="2.6 2.2" />
      <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2.9c0 1.7-2.6 2.2-2.6 3.7" />
      <path d="M12 17.2h.01" strokeWidth={2.6} />
    </svg>
  );
}

function StaleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
      <path d="M4.5 4.5 19.5 19.5" strokeWidth={1.4} />
    </svg>
  );
}

export function statusCopy(status: OfferStatus, locale?: Locale) {
  const t = getStrings(locale ?? "en");
  if (status === "verified") {
    return { label: t.statusVerified, tip: t.statusVerifiedTip, cls: "is-verified" };
  }
  if (status === "stale") {
    return { label: t.statusStale, tip: t.statusStaleTip, cls: "is-stale" };
  }
  return { label: t.statusUnverified, tip: t.statusUnverifiedTip, cls: "is-unverified" };
}

export default function OfferStatusToken({
  status,
  locale,
}: {
  status: OfferStatus;
  locale?: Locale;
}) {
  const t = getStrings(locale ?? "en");
  const copy = statusCopy(status, locale);
  return (
    <span
      className={`rc-status ${copy.cls}`}
      role="img"
      aria-label={`${t.offerStatusAria}: ${copy.label}. ${copy.tip}`}
      title={copy.tip}
      tabIndex={0}
      data-tip={copy.tip}
    >
      {status === "verified" ? <VerifiedIcon /> : status === "stale" ? <StaleIcon /> : <UnverifiedIcon />}
      <span className="label">{copy.label}</span>
    </span>
  );
}

/**
 * Legend: sits once under the results heading and once on the product page.
 * Collapsed by default so it never pushes the first price below the fold
 * (AC15); the summary itself is a 44px target and the same tooltip sentences
 * are repeated per row.
 */
export function StatusLegend({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? "en");
  // Compact, always-visible legend: the three tokens with their tooltips.
  // It sits once under the results heading and once on the product page; at
  // 22px tall it does not push the first price below the fold (AC15).
  return (
    <div className="rc-legend" role="group" aria-label={t.statusLegendAria}>
      <span className="rc-legend-title">{t.tableStatus}</span>
      {(["verified", "unverified", "stale"] as const).map((status) => (
        <OfferStatusToken key={status} status={status} locale={locale} />
      ))}
    </div>
  );
}
