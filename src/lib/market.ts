/**
 * REEA-1142 — market scope for the live offer set.
 *
 * The site is Kuwait-first: the served chrome says "Kuwait · prices in KWD"
 * (i18n marketLine) and the default market is Kuwait. A retailer adapter is
 * scoped to ONE storefront's market (see the `country` tag in
 * lib/collect/live-search.ts), and an offer's currency is the storefront's
 * currency. Before this module a Saudi storefront's SAR offer was rendered on
 * the Kuwait surface with no market label and could win the "best effective
 * price" headline after an approximate ≈KD conversion (REEA-1142, the
 * danube.sa case).
 *
 * The policy accepted for this ticket keeps cross-market offers (they are the
 * only lane for grocery/health queries) but makes the market explicit:
 *  - every offer carries a market tag derived from its own currency;
 *  - an offer whose market differs from the SELECTED market is cross-market:
 *    it renders with its market label ("Saudi price · ≈KD X") and is never
 *    eligible for the headline / "Best price" claim;
 *  - the headline is the cheapest in-stock offer of the selected market, or,
 *    when there is none, the honest "No Kuwait offer · Saudi price from KD X".
 *
 * With no explicit selection the surface still presents Kuwait (home market),
 * so a generic visitor sees the same labels and headline rule. Nothing here
 * fetches: the tag is pure derivation from the served currency, and every
 * number is arithmetic over the served figures.
 */
import { countryForCurrency, currencyForCountry, type CountryCode } from "@/lib/country";
import {
  effectivePriceKwd,
  formatPrice,
  toKwdFactor,
  toKwdNumeric,
} from "@/lib/format";
import { effectiveKwdOfOffer } from "@/lib/price-composition";
// REEA-1178 AC3 — the ONE sanity predicate (dependency-free, so no cycle with
// lib/offer-integrity.ts which imports offerMarket from this module).
import { isPossibleMismatchOffer } from "@/lib/sanity-verdict";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/** The company's home market — the market the served chrome presents when the
 *  shopper has not picked one (REEA-1142 AC2: "on a Kuwait search"). */
export const HOME_MARKET: CountryCode = "KW";

/** The market a surface is speaking for: the explicit selection, else home. */
export function marketScope(country: CountryCode | null | undefined): CountryCode {
  return country ?? HOME_MARKET;
}

/**
 * REEA-1177 AC 6d-1/6d-2 — the results view scope. An explicit `market=ALL`
 * is the null selection (every offer stays visible, tagged); the default
 * (no selection at all, undefined) is Kuwait. This is distinct from the
 * legacy `marketScope(null) → KW` helper so the ALL view is addressable.
 */
export function marketViewScope(
  country: CountryCode | null | undefined,
): CountryCode | null {
  return country === undefined ? HOME_MARKET : country;
}

/** The market a listing belongs to, derived from the currency its own
 *  storefront stamped. Unknown currencies stay untagged (never guessed). */
export function offerMarket(currency: string): CountryCode | null {
  return countryForCurrency(currency);
}

/** True when this listing's market is known and differs from the scope. */
export function isCrossMarketOffer(
  offer: { currency: string },
  scope: CountryCode | null,
): boolean {
  if (scope === null) return false; // ALL view: every market is in scope
  const market = offerMarket(offer.currency);
  return market !== null && market !== scope;
}

/** Split a rendered offer set into the selected market's offers and the
 *  cross-market ones. Order inside each half is preserved (the caller's
 *  price/live ordering already ran). */
export function partitionOffersByMarket<T extends { currency: string }>(
  offers: readonly T[],
  scope: CountryCode | null,
): { local: T[]; crossMarket: T[] } {
  if (scope === null) return { local: [...offers], crossMarket: [] };
  const local: T[] = [];
  const crossMarket: T[] = [];
  for (const offer of offers) {
    (isCrossMarketOffer(offer, scope) ? crossMarket : local).push(offer);
  }
  return { local, crossMarket };
}

function effectiveKeyOf(offer: PriceOffer, couponDiscount?: string | null): number {
  // REEA-1177 AC 6a-4 — the served effectivePrice (composition) is the ONE
  // ordering key; legacy offers without it fall back to the arithmetic.
  if (typeof offer.effectivePrice === "number" && Number.isFinite(offer.effectivePrice)) {
    return Math.max(0, offer.effectivePrice);
  }
  if (offer.priceComposition) {
    return effectiveKwdOfOffer(offer);
  }
  return effectivePriceKwd(offer.price, offer.currency, {
    wasPrice: offer.wasPrice,
    couponDiscount,
  });
}

/**
 * Market-scoped ordering for every rendered offer list: the selected market's
 * offers lead (live before snapshot, in-stock before out-of-stock, cheapest
 * effective first — the REEA-510/REEA-604 ladder unchanged), and cross-market
 * offers follow on the same ladder. A converted Saudi price can therefore
 * never lead a Kuwait card's price list or its lead CTA.
 */
export function sortOffersByMarket<T extends PriceOffer>(
  offers: readonly T[],
  coupon: { discount: string } | null | undefined,
  scope: CountryCode | null,
): T[] {
  const key = (o: T) => effectiveKeyOf(o, coupon?.discount ?? null);
  const ladder = (a: T, b: T): number =>
    (a.fromSnapshot ? 1 : 0) - (b.fromSnapshot ? 1 : 0) ||
    (a.inStock ? 0 : 1) - (b.inStock ? 0 : 1) ||
    key(a) - key(b);
  return [...offers].sort((a, b) => {
    const aCross = isCrossMarketOffer(a, scope);
    const bCross = isCrossMarketOffer(b, scope);
    if (aCross !== bCross) return aCross ? 1 : -1;
    return ladder(a, b);
  });
}

function eligibleHeadline(offer: PriceOffer): boolean {
  // REEA-1178 AC3 — the headline price is the card's own product. A
  // possible-mismatch offer (low outlier / price-integrity flag) is not
  // comparable evidence: live `fb1747d2` the KD 2.9 Amazon.eg accessory would
  // otherwise have led the Anker earbuds card's price.
  return offer.inStock && !isPossibleMismatchOffer(offer);
}

/** Cheapest in-stock, unflagged offer of the SELECTED market — the headline
 *  offer (AC2). Null when the card has no local offer at all. */
export function headlineOfferFor<T extends PriceOffer>(
  offers: readonly T[],
  scope: CountryCode | null,
): T | null {
  const localOffers = offers.filter((o) => !isCrossMarketOffer(o, scope));
  const local = localOffers.filter(eligibleHeadline);
  // REEA-1178 — a card whose every local offer is flagged/mismatch still
  // renders its own cheapest local figure (with its warning) instead of
  // falling through to the cross-market "no local offer" copy.
  const pool = local.length > 0 ? local : localOffers.filter((o) => o.inStock);
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (effectiveKeyOf(a) <= effectiveKeyOf(b) ? a : b));
}

/** Cheapest in-stock, unflagged cross-market offer — the honest fallback when
 *  the card has no offer in the selected market (AC2's "Saudi price from"). */
export function cheapestCrossMarketOffer<T extends PriceOffer>(
  offers: readonly T[],
  scope: CountryCode | null,
): T | null {
  if (scope === null) return null;
  const cross = offers.filter((o) => isCrossMarketOffer(o, scope) && eligibleHeadline(o));
  if (cross.length === 0) return null;
  return cross.reduce((a, b) => (effectiveKeyOf(a) <= effectiveKeyOf(b) ? a : b));
}

/** English market adjective for the row/headline copy ("Saudi price"). */
const MARKET_ADJECTIVE: Record<CountryCode, string> = {
  KW: "Kuwait",
  SA: "Saudi",
  EG: "Egypt",
};

function marketLabelForCopy(market: CountryCode, locale?: Locale): string {
  return locale === "ar" ? marketName(market, locale) : MARKET_ADJECTIVE[market];
}

/** AC1 row label — "Saudi price" / "سعر السعودية" (market adjective in EN,
 *  country name in AR). */
export function marketPriceLabel(market: CountryCode, locale?: Locale): string {
  const t = getStrings(locale ?? "en");
  return fill(t.marketPrice, { market: marketLabelForCopy(market, locale) });
}

/** The selected market's localized name ("Kuwait" / "الكويت"). */
export function marketName(market: CountryCode, locale?: Locale): string {
  const t = getStrings(locale ?? "en");
  if (market === "SA") return t.countrySA;
  if (market === "EG") return t.countryEG;
  return t.countryKW;
}

/**
 * Converted figure in the SELECTED market's currency. The reference table
 * (REEA-195/604) is unchanged; the label is the site's ≈ treatment for a
 * derived amount (REEA-281: ≤2 decimals, ≈ prefix).
 */
export function convertedLabel(
  price: number,
  currency: string,
  scope: CountryCode,
  opts?: { approx?: boolean },
): string {
  const target = currencyForCountry(scope);
  const factor = toKwdFactor(target);
  const native = currency.trim().toUpperCase();
  if (!factor || native === target) {
    // Same currency: the figure is native, never an approximation.
    return formatPrice(price, native || target);
  }
  const converted = toKwdNumeric(price, native) / factor;
  const label = formatPrice(converted, target);
  return opts?.approx === false ? label : `≈${label}`;
}

/**
 * AC1 — the row label for one cross-market listing: "Saudi price · ≈KD 0.47"
 * (EN) / "سعر السعودية · ≈KD 0.47" (AR). The market is always named, so an
 * approximate conversion can never read as verified local stock.
 */
export function crossMarketRowLabel(
  offer: { price: number; currency: string },
  scope: CountryCode,
  locale?: Locale,
): { market: string; price: string } | null {
  const market = offerMarket(offer.currency);
  if (market === null || market === scope) return null;
  const t = getStrings(locale ?? "en");
  return {
    market: fill(t.marketPrice, { market: marketLabelForCopy(market, locale) }),
    price: convertedLabel(offer.price, offer.currency, scope),
  };
}

/**
 * REEA-1198 — the headline split into the wrapping sentence and the price
 * token, so the UI can render `KD 0.47` in ONE non-breaking span while the
 * sentence itself still wraps. The price token is a single figure: splitting
 * it across lines ("KD" / "0.47") reads as a broken number on the exact
 * disclosed-fallback path. `prefix` ends with the template's lead-in word
 * ("from " / "من ") and `price` is the converted figure.
 */
export interface CrossMarketHeadlineParts {
  prefix: string;
  price: string;
  suffix: string;
}

/**
 * AC2 — the honest headline when the card has no offer in the selected
 * market: "No Kuwait offer · Saudi price from KD 0.47" (EN+AR). Returns null
 * when a local offer exists (the normal headline is used instead).
 */
export function crossMarketHeadline(
  offers: readonly PriceOffer[],
  scope: CountryCode | null,
  locale?: Locale,
  opts?: { pending?: boolean },
): string | null {
  const parts = crossMarketHeadlineParts(offers, scope, locale, opts);
  return parts === null ? null : `${parts.prefix}${parts.price}${parts.suffix}`;
}

/** REEA-1198 — the same headline as its two render parts (sentence, price).
 *
 *  REEA-1217 — `opts.pending` selects the interim sentence: while the selected
 *  market's batch may still land, the card cannot claim there is NO local
 *  offer. The pending form states the foreign price it holds ("Saudi price
 *  from KD X") and leaves the "No {market} offer" claim to the settled state.
 *  The settled default is unchanged, so a converged card keeps its full
 *  disclosure. */
export function crossMarketHeadlineParts(
  offers: readonly PriceOffer[],
  scope: CountryCode | null,
  locale?: Locale,
  opts?: { pending?: boolean },
): CrossMarketHeadlineParts | null {
  if (scope === null) return null; // ALL view: no single foreign market to name
  // A local offer exists → the normal headline is used, not this line.
  if (headlineOfferFor(offers, scope) !== null) return null;
  const cross = cheapestCrossMarketOffer(offers, scope);
  if (cross === null) return null;
  const market = offerMarket(cross.currency);
  if (market === null) return null;
  const t = getStrings(locale ?? "en");
  const values = {
    market: marketName(scope, locale),
    marketOther: marketLabelForCopy(market, locale),
  };
  // Fill the sentence and the price separately: the {price} slot is the ONLY
  // place a line break could split the figure, and it is rendered as its own
  // nowrap token by the card/hero.
  const template = opts?.pending
    ? t.crossMarketHeadlinePending
    : t.crossMarketHeadline;
  const [head, tail] = template.split("{price}");
  return {
    prefix: fill(head, values),
    price: convertedLabel(cross.price, cross.currency, scope, { approx: false }),
    suffix: fill(tail ?? "", values),
  };
}

/** The lead-CTA sentence for a cross-market-only card: "Saudi price KD 0.47". */
export function crossMarketLeadLabel(
  offer: { price: number; currency: string },
  scope: CountryCode | null,
  locale?: Locale,
): string {
  if (scope === null) return formatPrice(offer.price, offer.currency);
  const market = offerMarket(offer.currency);
  const t = getStrings(locale ?? "en");
  return fill(t.crossMarketLead, {
    market: market === null ? "" : marketLabelForCopy(market, locale),
    price: convertedLabel(offer.price, offer.currency, scope, { approx: false }),
  });
}

/** Aggregate counter input: how many offers on a rendered set are cross-market
 *  (AC5). Pure; used by the results after() tail. */
export function countCrossMarketOffers(
  offers: readonly { currency: string }[],
  scope: CountryCode | null,
): number {
  return offers.reduce((n, o) => n + (isCrossMarketOffer(o, scope) ? 1 : 0), 0);
}

/** ISO short code used on the row badge ("KSA stock"). */
const MARKET_CODE: Record<CountryCode, string> = { KW: "KW", SA: "KSA", EG: "EG" };

export function marketCode(market: CountryCode): string {
  return MARKET_CODE[market];
}

/** AC1/CEO — the market-specific stock badge a cross-market row carries
 *  instead of the Kuwait "Verified" token: "KSA stock" / "مخزون السعودية". */
export function marketStockLabel(market: CountryCode, locale?: Locale): string {
  const t = getStrings(locale ?? "en");
  return fill(t.marketStock, {
    market: locale === "ar" ? marketName(market, locale) : marketCode(market),
  });
}

/**
 * REEA-1142 AC3 — the render-time market pass over a product list: every
 * offer is kept (cross-market offers stay visible, the policy accepted on
 * this ticket) and every offer carries its market tag. The renderer then
 * labels the cross-market rows and keeps them out of the headline claim.
 * Nothing is dropped, so the offer set the shopper sees is still exactly the
 * live fan-out's answer — only its market scope is made explicit.
 */
export function scopeProductsByMarket(
  products: readonly NormalizedProduct[],
  scope: CountryCode | null,
): NormalizedProduct[] {
  return products.map((p) => {
    const tagged = p.offers.map((o) => {
      const market = offerMarket(o.currency);
      return market && o.market !== market ? { ...o, market } : o;
    });
    // REEA-1177 AC 6d-3 — a market-scoped shelf is that market's shelf. A
    // product with at least one in-market offer renders only those; a product
    // with NO in-market offer keeps its cross-market rows (the only offer)
    // and the card names the market, currency, ≈KWD and delivery caveat.
    if (scope === null) return { ...p, offers: tagged };
    const local = tagged.filter((o) => !isCrossMarketOffer(o, scope));
    return { ...p, offers: local.length > 0 ? local : tagged };
  });
}
