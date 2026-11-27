"use client";

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { CountryCode } from "@/lib/country";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";
import { trackEvent } from "@/lib/telemetry";
import { buildWhatsAppShare } from "@/lib/whatsapp-share";
import type { NormalizedProduct } from "@/types/product";

/**
 * REEA-1255 — the WhatsApp share entry point, implemented to the REEA-1257
 * `spec` (placement §2, payload §3, states §4, copy §5, a11y §6, mechanism
 * §8).
 *
 * The anchor is server-rendered with the fully encoded `wa.me` URL built from
 * the same product/offers the surface renders in that request, and carries
 * `data-share-message` (the decoded message) so the clipboard fallback and the
 * committed probe read the SAME payload — never DOM-scraped text.
 *
 * Variants: `card` = the 44x44 icon-only control in the shelf card's media
 * overlay; `pdp` = the same control in the PDP media, icon-only <641 and a
 * pill with the visible label ≥641 (CSS).
 *
 * States per spec §4: default (real anchor), pressed (CSS), copied fallback
 * (window blocked -> clipboard + check/`Copied` + aria-live), copy-failed
 * (selectable `<output>` with the message), loading (`aria-disabled` until
 * the first in-stock offer resolves), no-offer (not-stocked message).
 */
export default function ShareWhatsAppButton({
  product,
  query = "",
  country,
  locale,
  origin = "",
  variant,
  loading = false,
}: {
  product: NormalizedProduct;
  /** The query the surface was reached with; omitted on a direct PDP visit. */
  query?: string;
  country?: CountryCode | null;
  locale?: Locale;
  /** Server-resolved site origin (lib/site-origin.ts). */
  origin?: string;
  variant: "card" | "pdp";
  /** True while the PDP collection is still running with no in-stock offer. */
  loading?: boolean;
}) {
  const loc = locale ?? clientLocale();
  const t = getStrings(loc);
  const share = buildWhatsAppShare({ product, query, country, locale: loc, origin });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPdp = variant === "pdp";
  const disabled = loading;
  const ariaLabel = disabled
    ? t.shareWaLoadingAria
    : isPdp
      ? t.shareWaAriaPdp
      : t.shareWaAriaCard;

  function markCopied(): void {
    setCopied(true);
    setCopyFailed(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2500);
  }

  async function onClick(event: ReactMouseEvent<HTMLAnchorElement>): Promise<void> {
    // Loading: the anchor is inert until the first in-stock offer resolves.
    if (disabled) {
      event.preventDefault();
      return;
    }
    // The anchor stays the happy path; the handler only adds the fallback.
    event.preventDefault();
    // Aggregate-only click counter: type only, no identifier (AC5b).
    trackEvent({ type: "share_whatsapp" });
    let win: Window | null = null;
    try {
      win = window.open(share.href, "_blank");
    } catch {
      win = null;
    }
    if (win) {
      // Sever the opener explicitly (the anchor's rel does not apply to a
      // programmatic window.open).
      try {
        win.opener = null;
      } catch {
        // some hosts throw on a cross-origin WindowProxy — harmless
      }
      return;
    }
    // WhatsApp window blocked / offline / unsupported client: copy the
    // server-rendered message, never a DOM-scraped rebuild.
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(share.message);
        markCopied();
      } else {
        setCopyFailed(true);
      }
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <>
      <a
        href={share.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={ariaLabel}
        aria-disabled={disabled ? "true" : undefined}
        title={t.shareWaTitle}
        data-share-whatsapp="true"
        data-share-message={share.message}
        className={`rc-share-wa focusable ${
          isPdp ? "rc-share-wa--pdp" : "rc-share-wa--card"
        }${copied ? " is-copied" : ""}`}
        onClick={onClick}
      >
        {copied ? <CheckGlyph /> : <WhatsAppGlyph />}
        {isPdp ? (
          <span className="rc-share-wa__label">
            {copied ? t.shareWaCopied : t.shareWaLabel}
          </span>
        ) : null}
      </a>
      {/* Spec §6 — one polite announcement, no focus move. */}
      <span
        aria-live="polite"
        style={{
          position: "absolute",
          inlineSize: 1,
          blockSize: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? t.shareWaCopiedAnnounce : ""}
      </span>
      {copyFailed ? (
        <output className="rc-share-wa__fallback">{share.message}</output>
      ) : null}
    </>
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

function CheckGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}
