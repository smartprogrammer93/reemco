/**
 * REEA-1255 — the WhatsApp text+link share behind the results comparison
 * surface.
 *
 * Kuwait's purchase decision happens in a WhatsApp group: one shopper finds a
 * price and sends it to the family/friends chat. The site had only a clipboard
 * copy, so the comparison died in the tab. This builder turns the SAME live
 * offers the page renders into one prefilled message and a `wa.me` link.
 *
 * Honesty rules (AC2/AC3):
 *  - the message quotes the page's own figures: every price goes through the
 *    same `formatCountryPrice` + market-scope chain the card uses, so a
 *    non-KWD source reads `≈KD …` and never a bare native amount under a KD
 *    label;
 *  - only IN-MARKET offers ride the message (the selected market, else the
 *    home market Kuwait), in the card's own paint order, capped at three;
 *  - a page with no in-market offer says "Not stocked in Kuwait" instead of
 *    quoting a KD 0;
 *  - the URL carries only the origin, the results path and the query. No
 *    session/device/timestamp/token ever enters the payload.
 *
 * No clock, no randomness, no locale-dependent formatting: the caller passes
 * the server-resolved locale/country/origin, so SSR and hydration produce the
 * same anchor. The click counter is the separate aggregate `share_whatsapp`
 * event (no properties, no identifier).
 */
import type { CountryCode } from "@/lib/country";
import { formatCountryPrice } from "@/lib/format";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import { HOME_MARKET, isCrossMarketOffer } from "@/lib/market";
import { visibleShelfOffers } from "@/lib/results-offers";
import type { NormalizedProduct } from "@/types/product";

/** AC2 — up to three cheapest in-market offers ride the message. */
export const WHATSAPP_SHARE_MAX_OFFERS = 3;

/** The WhatsApp click-to-chat entry point (text is URL-encoded). */
export const WHATSAPP_SHARE_BASE = "https://wa.me/";

/** AC3 — the whole href must stay well under WhatsApp's 2,000-char ceiling. */
export const WHATSAPP_SHARE_MAX_HREF = 2000;

export interface WhatsAppShare {
  /** `https://wa.me/?text=…` — the rendered anchor href. */
  href: string;
  /** Decoded prefilled message (query + offers + page URL). */
  text: string;
  /** True when at least one in-market offer rode the message. */
  hasOffers: boolean;
  /** The product the comparison belongs to, or null on a zero-offer page. */
  productId: string | null;
}

/**
 * The results share URL. AC3: only origin + `/results` + the query. The page
 * number is a viewer slice, not part of the comparison identity, so the share
 * points at the query's canonical first page. No locale marker is added: the
 * site encodes locale in a cookie, not the URL.
 */
export function resultsShareUrl(origin: string, query: string): string {
  return `${origin.replace(/\/+$/, "")}/results?q=${encodeURIComponent(query)}`;
}

/** The product-detail share URL (same component reused on the PDP). */
export function productShareUrl(origin: string, productId: string): string {
  return `${origin.replace(/\/+$/, "")}/product/${encodeURIComponent(productId)}`;
}

/**
 * Build the prefilled message from the page's own rendered cards. The first
 * card carrying an in-market offer is the comparison the shopper can send; a
 * page with no such card states "Not stocked in Kuwait".
 */
export function buildWhatsAppShare(opts: {
  /** The cards this page actually paints (already page-sliced/filtered). */
  products: readonly NormalizedProduct[];
  query: string;
  /** The full page URL the share should open. */
  pageUrl: string;
  locale: Locale;
  /** The viewer's market selection; null/undefined = the home market (KW). */
  country?: CountryCode | null;
}): WhatsAppShare {
  const t = getStrings(opts.locale);
  const scope = opts.country ?? HOME_MARKET;
  const lead = fill(t.whatsappShareLead, { brand: t.whatsappShareBrand, q: opts.query });

  let chosen: { product: NormalizedProduct; offers: { merchant: string; price: string }[] } | null =
    null;
  for (const product of opts.products) {
    // The card's OWN visible offer projection (market scoping, coupon
    // composition, fold, ordering) — never a second chain that could print a
    // different figure. `cardRows` is the set the card paints; local rows keep
    // the in-market rule and the paint order.
    const rows = visibleShelfOffers(product, scope).cardRows.filter(
      (offer) => !isCrossMarketOffer(offer, scope),
    );
    if (rows.length === 0) continue;
    chosen = {
      product,
      offers: rows.slice(0, WHATSAPP_SHARE_MAX_OFFERS).map((offer) => ({
        merchant: offer.merchant.trim(),
        // AC2 — identical to the figure the card renders for this row.
        price: formatCountryPrice(offer.price, offer.currency, scope).primary,
      })),
    };
    break;
  }

  const body =
    chosen && chosen.offers.length > 0
      ? `${lead} ${shareTitle(chosen.product.title)} — ${chosen.offers.map((o) => `${o.merchant} ${o.price}`).join(" · ")}`
      : `${lead} ${t.notStockedInKuwait}`;
  const text = `${body}\n${opts.pageUrl}`;
  const href = `${WHATSAPP_SHARE_BASE}?text=${encodeURIComponent(text)}`;

  return {
    href,
    text,
    hasOffers: chosen !== null && chosen.offers.length > 0,
    productId: chosen?.product.productId ?? null,
  };
}

/** The product the comparison belongs to names the message on a multi-card
 *  results page (the query alone would not say which product's prices these
 *  are). Capped so the href stays well under the 2,000-char AC3 ceiling. */
export const WHATSAPP_SHARE_MAX_TITLE = 80;

function shareTitle(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= WHATSAPP_SHARE_MAX_TITLE) return clean;
  return `${clean.slice(0, WHATSAPP_SHARE_MAX_TITLE - 1)}…`;
}

