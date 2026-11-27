/**
 * REEA-1247 — nearest in-market recovery for a zero-offer results page.
 *
 * The defect this module answers: on a zero-offer page the old page padded the
 * shelf with unrelated accessories ("Accessories for this product" holding a
 * children's book and a games console) while the lane line claimed stores
 * "carry this". Recovery must instead be REAL live offers from the SAME run
 * that were near the query, and each one must be in market (Kuwait) to be
 * presented as a "closest match". A card whose only offers are foreign is not
 * a Kuwait match: it is separated into the foreign-alternatives band.
 *
 * Pure and client-safe (no React, no I/O, no clock): the renderer calls it with
 * the run's own snapshot products, so nothing is fabricated and nothing is
 * bundled. The matched term is derived from the shopper's own query tokens —
 * never guessed from a static catalogue.
 */
import { HOME_MARKET, offerMarket } from "@/lib/market";
import { effectiveKwdOfOffer } from "@/lib/price-composition";
import { matchesQueryToken, queryMatchTokens } from "@/lib/relevance";
import type { CountryCode } from "@/lib/country";
import type { NormalizedProduct, PriceOffer } from "@/types/product";

/** AC4: at most five nearest in-market matches. */
export const RECOVERY_CAP = 5;

/**
 * Function words that carry no product signal. Excluding them is what keeps
 * "xyzzy no such thing" from labelling a HONOR Pad as a "no" match (the
 * substring matcher sees "no" inside "HONOR"). Only words that never identify
 * a product are listed; brand/model words stay.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "my",
  "no",
  "of",
  "on",
  "or",
  "our",
  "such",
  "that",
  "the",
  "this",
  "to",
  "with",
  "your",
  "من",
  "في",
  "على",
  "مع",
  "إلى",
  "الى",
  "أو",
  "او",
  "ثم",
  "هذا",
  "هذه",
  "ذلك",
  "التي",
  "الذي",
  "عن",
]);

const ARABIC_RE = /[\u0600-\u06FF]/;

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

/**
 * The query tokens this title actually carries, in the shopper's token order.
 * Latin tokens match on a title token boundary (plus the model-containment
 * rule the rest of the site uses: "xm6" answers "WH-1000XM6"); Arabic tokens
 * go through the shared alias-aware matcher. A title with no matching token is
 * not "related" at all — it must not be padded into recovery.
 */
export function matchedTermsFor(query: string, title: string): string[] {
  const tokens = queryMatchTokens(query).filter((t) => !STOPWORDS.has(t));
  if (tokens.length === 0) return [];
  const lower = title.toLowerCase();
  const words = titleTokens(title);
  const matched: string[] = [];
  for (const token of tokens) {
    if (ARABIC_RE.test(token)) {
      if (matchesQueryToken(lower, token)) matched.push(token);
      continue;
    }
    if (words.includes(token)) {
      matched.push(token);
      continue;
    }
    // Model containment: one digit-carrying title token ends with the query
    // stem ("wh1000xm6" / "1000xm6" meet "xm6"), same rule as titleMatchScore.
    if (words.some((w) => /\d/.test(w) && w.endsWith(token))) matched.push(token);
  }
  return matched;
}

export interface RecoveryItem {
  product: NormalizedProduct;
  /** The query term this item actually carries (AC4 "matched term named"). */
  matchedTerm: string;
  matchedTerms: string[];
  /** In-market offers only; the cheapest one supplies the displayed price. */
  offers: PriceOffer[];
  price: number;
  currency: string;
}

export interface ForeignAlternative {
  product: NormalizedProduct;
  matchedTerm: string;
  matchedTerms: string[];
  offers: PriceOffer[];
  price: number;
  currency: string;
  market: CountryCode;
}

export interface ZeroRecovery {
  /** ≤ RECOVERY_CAP Kuwait-offer matches, nearest first. */
  inMarket: RecoveryItem[];
  /** ≤ RECOVERY_CAP matched items with only foreign offers (clearly separate). */
  foreign: ForeignAlternative[];
}

/**
 * Nearest-first: more matched query terms wins, then the cheaper displayed
 * price, then productId (deterministic for the same snapshot). Price alone
 * must not outrank closeness — a "case" match on an unrelated cover is not
 * nearer than a two-term model match just because it is cheaper.
 */
function rankNearest<
  K extends { matchedTerms: string[]; price: number; product: { productId: string } },
>(items: K[]): K[] {
  return [...items].sort(
    (a, b) =>
      b.matchedTerms.length - a.matchedTerms.length ||
      a.price - b.price ||
      a.product.productId.localeCompare(b.product.productId),
  );
}

/**
 * Derive the recovery sets from the run's own snapshot products.
 *
 * `products` must already carry the viewer's stock/country selections (the
 * caller passes the same partitioned set the zero page renders), so recovery
 * never surfaces a row a filter hid. "In market" is Kuwait (the site's home
 * market), independent of the selected view: the AC asks for in-market matches
 * on a zero-offer page, and a foreign-only item is an alternative, not a match.
 */
export function nearestMatches(
  query: string,
  products: readonly NormalizedProduct[],
): ZeroRecovery {
  const candidates = products
    .map((product) => {
      const matchedTerms = matchedTermsFor(query, product.title);
      if (matchedTerms.length === 0) return null;
      return { product, matchedTerms, matchedTerm: matchedTerms[0] };
    })
    .filter((c): c is { product: NormalizedProduct; matchedTerms: string[]; matchedTerm: string } => c !== null);
  // Nearest first: more matched query terms is nearer, then the cheaper
  // in-market price. Deterministic (price, then productId) so repeated renders
  // of the same snapshot paint the same list.
  candidates.sort(
    (a, b) =>
      b.matchedTerms.length - a.matchedTerms.length ||
      a.product.title.localeCompare(b.product.title) ||
      a.product.productId.localeCompare(b.product.productId),
  );

  const inMarket: RecoveryItem[] = [];
  const foreign: ForeignAlternative[] = [];
  for (const c of candidates) {
    const kw = c.product.offers.filter((o) => offerMarket(o.currency) === HOME_MARKET);
    if (kw.length > 0) {
      const priced = [...kw].sort((a, b) => effectiveKwdOfOffer(a) - effectiveKwdOfOffer(b))[0];
      inMarket.push({
        product: c.product,
        matchedTerm: c.matchedTerm,
        matchedTerms: c.matchedTerms,
        offers: kw,
        price: priced.price,
        currency: priced.currency,
      });
      continue;
    }
    const outside = c.product.offers.filter((o) => {
      const m = offerMarket(o.currency);
      return m !== null && m !== HOME_MARKET;
    });
    if (outside.length === 0) continue;
    const priced = [...outside].sort((a, b) => effectiveKwdOfOffer(a) - effectiveKwdOfOffer(b))[0];
    foreign.push({
      product: c.product,
      matchedTerm: c.matchedTerm,
      matchedTerms: c.matchedTerms,
      offers: outside,
      price: priced.price,
      currency: priced.currency,
      market: offerMarket(priced.currency) ?? HOME_MARKET,
    });
  }

  return {
    inMarket: rankNearest(inMarket).slice(0, RECOVERY_CAP),
    foreign: rankNearest(foreign).slice(0, RECOVERY_CAP),
  };
}
