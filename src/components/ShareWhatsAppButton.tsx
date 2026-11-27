"use client";

import { clientLocale, getStrings, type Locale } from "@/lib/i18n";
import { trackEvent } from "@/lib/telemetry";
import { buildWhatsAppShare } from "@/lib/whatsapp-share";
import type { CountryCode } from "@/lib/country";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-1255 — the WhatsApp share entry point on the comparison surface.
 *
 * The href is computed during render from the SAME live cards/props the page
 * paints (lib/whatsapp-share.ts reuses the card's visible-offer projection and
 * price formatter), so the prefilled message cannot quote a figure the shopper
 * did not just see. It is a real anchor with `target="_blank"`, not a JS
 * window.open: keyboard reachable by default, and the served HTML carries the
 * href for the committed probe.
 *
 * The click fires the aggregate-only `share_whatsapp` funnel event — no
 * properties, no session/user identifier. Opening a new tab does not unload
 * this document, so the beacon still lands.
 */
export default function ShareWhatsAppButton({
  products,
  query,
  pageUrl,
  country,
  locale,
  iconOnly = false,
}: {
  /** The page's rendered cards; the first in-market comparison is shared. */
  products: readonly NormalizedProduct[];
  query: string;
  /** The full page URL the share should open (origin + path + query only). */
  pageUrl: string;
  country?: CountryCode | null;
  locale?: Locale;
  /** A 44x44 icon control (card overlay); the default is a labelled pill. */
  iconOnly?: boolean;
}) {
  const loc = locale ?? clientLocale();
  const t = getStrings(loc);
  const share = buildWhatsAppShare({ products, query, pageUrl, locale: loc, country });

  function onShare(): void {
    // AC5 — aggregate integer only; the event schema keeps just `type`.
    trackEvent({ type: "share_whatsapp" });
  }

  if (iconOnly) {
    return (
      <a
        href={share.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t.whatsappShareAria}
        className="rc-icon-btn focusable"
        data-share-whatsapp="true"
        onClick={onShare}
        style={{ background: "var(--rc-surface)", border: "1px solid var(--rc-line)" }}
      >
        <WhatsAppGlyph />
      </a>
    );
  }
  return (
    <a
      href={share.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t.whatsappShareAria}
      className="query-pill query-pill-on-light focusable ms-auto shrink-0 whitespace-nowrap"
      data-share-whatsapp="true"
      onClick={onShare}
      style={{ minBlockSize: "var(--rc-tap)", gap: 6 }}
    >
      <WhatsAppGlyph />
      {t.whatsappShareLabel}
    </a>
  );
}

function WhatsAppGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}
