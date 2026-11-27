/**
 * REEA-1255 — the WhatsApp text+link share behind the comparison surface.
 *
 * Visual/UX source of truth: REEA-1257 `spec` (placement, payload, states,
 * EN/AR copy, 375/1280). This module owns the PAYLOAD only; the anchor's
 * placement/states live in ShareWhatsAppButton.
 *
 * Spec §3 rules implemented here:
 *  - product title = the rendered title (cleanDisplayTitle), capped at 80;
 *  - offers = the surface's in-market, IN-STOCK offers, deduped by retailer
 *    (cheapest per retailer), sorted ascending by the converted KD value,
 *    capped at 3;
 *  - each line = `{n}. {retailer} {price}` where price is the same
 *    formatCountryPrice figure the surface renders (`≈KD` preserved for a
 *    non-KWD source, never a bare native amount under a KD label);
 *  - link = the canonical PDP URL (origin + /product/<id>), with `?q=` only
 *    when the surface's rendered PDP link carries it; every other parameter
 *    is stripped;
 *  - AR wraps the Latin retailer/price runs and a Latin product title in
 *    U+2066/U+2069 so the RTL sentence does not reorder them;
 *  - 0 in-stock offers = the not-stocked template with the PDP link, never
 *    `KD 0`;
 *  - `href = https://wa.me/?text=` + encodeURIComponent(message), asserted
 *    under 2,000 characters.
 *
 * Pure: no clock, no randomness, no client env reads. The server render
 * passes origin/query/locale/country down, so SSR and hydration agree.
 */
import type { CountryCode } from "@/lib/country";
import { cleanDisplayTitle } from "@/lib/display-title";
import { formatCountryPrice, toKwdNumeric } from "@/lib/format";
import { getStrings, type Locale } from "@/lib/i18n";
import { HOME_MARKET, isCrossMarketOffer } from "@/lib/market";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/** Spec §3.1 — 3 offer lines max. */
export const WHATSAPP_SHARE_MAX_OFFERS = 3;
/** Spec §3.2 rule 4 — the final wa.me URL must stay under 2,000 chars. */
export const WHATSAPP_SHARE_MAX_HREF = 2000;
/** Spec §3.2 rule 1 — title cap (77 + ellipsis). */
export const WHATSAPP_SHARE_MAX_TITLE = 80;

/** Bidi isolate characters for the AR message (spec §3.2 rule 7). */
const LRI = "\u2066";
const PDI = "\u2069";

export interface WhatsAppShare {
  /** `https://wa.me/?text=…` — the rendered anchor href. */
  href: string;
  /** Decoded prefilled message (also emitted as data-share-message). */
  message: string;
  /** True when at least one in-stock in-market offer rode the message. */
  hasOffers: boolean;
}

/** Cap the rendered title per spec §3.2 rule 1 (77 + …). */
export function capShareTitle(raw: string): string {
  const clean = cleanDisplayTitle(raw).replace(/\s+/g, " ").trim();
  if (clean.length <= WHATSAPP_SHARE_MAX_TITLE) return clean;
  return `${clean.slice(0, WHATSAPP_SHARE_MAX_TITLE - 3)}…`;
}

/** The canonical PDP URL: origin + /product/<id>, plus ?q= only when the
 *  surface's rendered PDP link carries the query. Other params are stripped. */
export function buildPdpShareUrl(
  origin: string,
  productId: string,
  query?: string,
): string {
  const base = `${origin.replace(/\/+$/, "")}/product/${encodeURIComponent(productId)}`;
  return query && query.trim() !== "" ? `${base}?q=${encodeURIComponent(query.trim())}` : base;
}

interface ShareOffer {
  retailer: string;
  price: string;
  kwd: number;
}

/**
 * The offers the surface renders for the selected market, in-stock only,
 * deduped by retailer (cheapest per retailer), ascending by converted KD.
 */
export function shareOffers(
  product: NormalizedProduct,
  scope: CountryCode,
): ShareOffer[] {
  const byRetailer = new Map<string, ShareOffer>();
  for (const offer of product.offers as PriceOffer[]) {
    if (!offer.inStock) continue;
    if (isCrossMarketOffer(offer, scope)) continue;
    const retailer = (offer.merchant ?? "").trim();
    if (!retailer) continue;
    const key = retailer.toLowerCase();
    const kwd = toKwdNumeric(offer.price, offer.currency);
    const candidate: ShareOffer = {
      retailer,
      price: formatCountryPrice(offer.price, offer.currency, scope).primary,
      kwd,
    };
    const current = byRetailer.get(key);
    if (!current || candidate.kwd < current.kwd) byRetailer.set(key, candidate);
  }
  return [...byRetailer.values()]
    .sort((a, b) => a.kwd - b.kwd || a.retailer.localeCompare(b.retailer))
    .slice(0, WHATSAPP_SHARE_MAX_OFFERS);
}

function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function bidiTitle(title: string, locale: Locale): string {
  // Spec §3.2 rule 7 — isolate a Latin title inside the AR sentence.
  return locale === "ar" && !hasArabic(title) ? `${LRI}${title}${PDI}` : title;
}

function offerToken(offer: ShareOffer, locale: Locale, index: number): string {
  const token = `${offer.retailer} ${offer.price}`;
  return locale === "ar" ? `${index + 1}. ${LRI}${token}${PDI}` : `${index + 1}. ${token}`;
}

export function buildWhatsAppShare(opts: {
  product: NormalizedProduct;
  /** The query the surface was reached with; omitted on a direct PDP visit. */
  query?: string;
  /** Server-resolved site origin (lib/site-origin.ts). */
  origin: string;
  locale: Locale;
  /** Viewer's market selection; null/undefined = the home market (KW). */
  country?: CountryCode | null;
}): WhatsAppShare {
  const t = getStrings(opts.locale);
  const scope = opts.country ?? HOME_MARKET;
  const title = capShareTitle(opts.product.title);
  const pdpUrl = buildPdpShareUrl(opts.origin, opts.product.productId, opts.query);
  const offers = shareOffers(opts.product, scope);

  const message =
    offers.length > 0
      ? opts.locale === "ar"
        ? `${bidiTitle(title, "ar")} — ${t.shareWaLead}\n${offers
            .map((o, i) => offerToken(o, "ar", i))
            .join("\n")}\n${t.shareWaLink} ${pdpUrl}`
        : `${title} — ${t.shareWaLead}\n${offers
            .map((o, i) => offerToken(o, "en", i))
            .join("\n")}\n${t.shareWaLink} ${pdpUrl}`
      : opts.locale === "ar"
        ? `${bidiTitle(title, "ar")} — ${t.shareWaNotStocked} ${pdpUrl}`
        : `${title} — ${t.shareWaNotStocked} ${pdpUrl}`;

  return {
    href: `https://wa.me/?text=${encodeURIComponent(message)}`,
    message,
    hasOffers: offers.length > 0,
  };
}
