/**
 * REEA-541 Bet B — the plain-text comparison summary behind the Copy button.
 *
 * One line in the EXACT on-screen order: sortOffers (live rows lead, in-stock
 * first, cheapest in KWD-space — the same contract the rendered rows use),
 * capped at the first five offers, each figure through formatCountryPrice so
 * the country selection decides the lead currency exactly as it does on the
 * card. Out-of-stock choices are honored through the offer set the caller was
 * given: every surface runs its country/stock selections before the card
 * renders (see stock.ts / country.ts contracts), so the summary and the rows
 * always describe the same visible set — the builder adds no second filter of
 * its own.
 *
 * The tail rides the existing freshness bucket label (REEA-65): "verified 3h
 * ago", with the stale suffix when >7d. A missing/unparseable stamp omits the
 * tail entirely — never a fabricated date. The lead and verified words come
 * from the static locale table (REEA-279), so EN and AR keep one layout and
 * the figures stay in the shared formatter's hands. Prices keep the existing
 * rendered form ("KD 4,099"), so a copied line reads like the card.
 */
import type { CountryCode } from "@/lib/country";
import { formatCountryPrice, sortOffers } from "@/lib/format";
import { freshness } from "@/lib/freshness";
import { getStrings, type Locale } from "@/lib/i18n";
import type { NormalizedProduct } from "@/types/product";

/** How many offers ride the line (Bet B AC1). */
export const SUMMARY_MAX_OFFERS = 5;

export function buildShareSummary(
  product: NormalizedProduct,
  opts: { locale: Locale; country?: CountryCode | null; now?: number },
): string {
  const t = getStrings(opts.locale);
  const country = opts.country ?? null;
  const now = opts.now ?? Date.now();
  const offers = sortOffers(product.offers, product.coupons[0] ?? null).slice(0, SUMMARY_MAX_OFFERS);
  const offerLine = offers
    .map((o) => `${o.merchant} ${formatCountryPrice(o.price, o.currency, country).primary}`)
    .join(" · ");
  const pieces: string[] = [];
  if (offerLine) pieces.push(offerLine);
  const fresh = freshness(product.scrapedAt, now);
  if (fresh) {
    pieces.push(`${t.shareVerifiedWord} ${fresh.label}${fresh.stale ? t.staleSuffix : ""}`);
  }
  const lead = `${product.title} — ${t.shareBestNowLead}:`;
  return pieces.length > 0 ? `${lead} ${pieces.join(" · ")}` : lead;
}
