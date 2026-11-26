/**
 * REEA-1178 — the ONE definition of offer-row / comparison integrity on a
 * served shelf card.
 *
 * Why this module exists: three surfaces read "how many retailers does this
 * card compare" and "is this row trustworthy" — the results card's retailer
 * count (and the savings/headline claims it gates), the weekly
 * `comparison_depth` fold, and the collector's own payload. Before this
 * module each of them derived its own answer, so the card counted RAW offers
 * (duplicate rows included, flagged offers included) while the metric counted
 * a different population. Live evidence on `fb1747d2`:
 *  - `/results?q=iphone%2017%20pro` painted 10 cards for 8 productIds
 *    (a "+ Wireless Charger" bundle reusing the base id), and
 *  - the Anker AeroFit 2 card's Amazon.eg accessory offer
 *    ("P47M Cat LED Over Stereo Music Card", EGP 245, ratioToMedian 0.09997,
 *    sanity `ok` because the cohort bound is 15×) counted as a comparison
 *    retailer and inflated `comparison_depth.cards_multi_retailer`.
 *
 * The rules here are derived ONLY from the fetched offer payload (its own
 * sanity verdict, merchant, price, currency and listing URL) — no bundled
 * catalog, no second fetch.
 *
 * AC3 threshold (ticket scope): an offer is a POSSIBLE MISMATCH when its
 * `ratioToMedian < 0.1`, or it carries a price-integrity flag
 * (`currency_mis_map` / `price_unavailable`), or it is flagged `outlier_low`.
 * Such a row stays visible with its own price and a marker, but it never
 * counts as a comparison lane. The threshold is deliberately tighter than the
 * collector's own cohort bound (PRICE_SANITY_OUTLIER_RATIO, 15× → ratio <
 * 1/15 ≈ 0.067): the live accessory that motivated the ticket sat at 0.09997
 * and was `ok`, i.e. the collector's flag alone was not enough to keep an
 * artefact out of the depth metric.
 *
 * One deliberate narrowing of the AC's shorthand ("or sanity.status != ok"):
 * `outlier_high` is NOT a mismatch. It is the same product priced above a
 * skewed cohort — live `fold 7` measured every phone at ratio 65–107× because
 * the cohort median was set by KD 4.9 cases. Excluding those would report zero
 * retailers on a card with four real stores (and zero comparison depth for
 * the whole panel), a worse outcome than a high price. See
 * `isPossibleMismatchOffer` for the exact rule.
 *
 * Pure and client-safe (no React, no I/O, no node built-ins): the results
 * renderer and the server-side metrics fold share this file verbatim.
 */
import type { CountryCode } from "@/lib/country";
import { offerMarket } from "@/lib/market";
import { normalizedListingUrlOf } from "@/lib/collect/types";

/**
 * AC3 — the ticket's possible-mismatch threshold. A KWD-space price at less
 * than a tenth of the cohort median is not a comparison figure for this
 * product: it is a cheaper thing that got merged into the card (an accessory,
 * a case, a screen protector).
 */
export const POSSIBLE_MISMATCH_RATIO = 0.1;

/**
 * The minimum a served offer must carry for the integrity rules to read it.
 * `PriceOffer` satisfies this shape, so the renderer can pass its rows
 * directly; the metrics fold maps its looser aggregate input onto it instead
 * of casting.
 */
export interface ComparisonOffer {
  merchant: string;
  price: number;
  currency: string;
  url: string;
  /** REEA-1142 market tag when the payload carries one. */
  market?: string;
  sanity?: { status?: string; reason?: string; ratioToMedian?: number };
}

type SanityBearing = Pick<ComparisonOffer, "sanity">;

/** True when the query-time sanity pass flagged this offer. */
export function isFlaggedOffer(offer: SanityBearing): boolean {
  return offer.sanity?.status === "flagged";
}

/**
 * AC3 — an offer that is not comparable evidence for the card.
 *
 * The ticket names the wrong-product signal precisely: an `outlier_low` price
 * below a tenth of the cohort median (and the same rule for an `ok` verdict
 * that still sits below it — the live Anker accessory was 0.09997 and `ok`
 * under the collector's 15× bound). A price-integrity failure
 * (`currency_mis_map`, `price_unavailable`) is never comparison evidence
 * either: the figure itself is not trustworthy.
 *
 * `outlier_high` is deliberately NOT a mismatch: it is the SAME product
 * priced above a skewed cohort. Live `fold 7` measured every phone at ratio
 * 65–107× because the cohort median is set by KD 4.9 cases — excluding those
 * would blank the retailer count on a card with four real stores, which is a
 * worse outcome than a high price. An offer with NO verdict (a surface that
 * never ran the pass) is not called a mismatch — absent evidence is not a
 * defect.
 */
export function isPossibleMismatchOffer(offer: SanityBearing): boolean {
  const sanity = offer.sanity;
  if (!sanity) return false;
  const ratio = sanity.ratioToMedian;
  if (sanity.reason === "currency_mis_map" || sanity.reason === "price_unavailable") return true;
  if (sanity.reason === "outlier_low") {
    return ratio == null || ratio < POSSIBLE_MISMATCH_RATIO;
  }
  if (sanity.status === "ok") {
    return typeof ratio === "number" && ratio < POSSIBLE_MISMATCH_RATIO;
  }
  // `outlier_high` (and any other flagged reason) stays a comparison lane.
  return false;
}

/**
 * AC2 — the row identity the shopper can actually act on: same merchant, same
 * price and same listing URL is ONE purchasable offer, however many times the
 * fetch returned it. Keeps the FIRST occurrence (callers pass rows already in
 * the served order: cheapest-first, live before snapshot).
 */
export function dedupeOfferRows<T extends { merchant: string; price: number; url: string }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = `${row.merchant.toLowerCase()}|${row.price}|${normalizedListingUrlOf(row.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * AC2/AC3 — the distinct in-market merchants that count as comparison lanes
 * on one card: rows deduped by merchant+price+URL, offers whose market is the
 * card's scope (a Saudi row is not a Kuwait comparison lane, REEA-1147 AC2),
 * and offers that are not a possible mismatch. Case-folded merchant identity
 * (REEA-787): "Xcite" and "xcite" are one retailer.
 *
 * `scope: null` keeps the pre-change all-market fold — used only by callers
 * that fold an aggregate without a market selection (historical reads, tests);
 * every shopper-facing surface passes its real scope.
 */
export function comparisonMerchantsOf(
  offers: readonly ComparisonOffer[],
  scope: CountryCode | null,
): string[] {
  const merchants = new Set<string>();
  for (const offer of dedupeOfferRows(offers ?? [])) {
    if (isPossibleMismatchOffer(offer)) continue;
    if (scope !== null) {
      const market = offer.market ? (offer.market as CountryCode) : offerMarket(offer.currency);
      if (market !== scope) continue;
    }
    const name = (offer.merchant ?? "").trim();
    if (!name) continue;
    merchants.add(name.toLowerCase());
  }
  return [...merchants];
}

/** Convenience: the integer the card prints and the claims gate read. */
export function comparisonMerchantCount(
  offers: readonly ComparisonOffer[],
  scope: CountryCode | null,
): number {
  return comparisonMerchantsOf(offers, scope).length;
}

/**
 * AC4 — the listing's own reference, for a row that carries no textual
 * qualifier but shares its merchant AND price with another row on the same
 * card (two Eureka listings of one 1TB phone at KD 489.90, one labelled
 * "Japanese VR"). Without a reference the two rows are visually identical and
 * the shopper cannot tell which regional version they are buying.
 *
 * The reference is the retailer's own listing code from the URL it served —
 * live evidence, nothing invented. Numeric detail ids are the common case
 * (Eureka `/products/details/267450`, Jarir `…-666717.html`). When the URL
 * carries no usable code the caller falls back to a stable ordinal.
 */
export function listingRefLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    // Retailer "product page" suffixes ("…/p", "…/product") are chrome.
    while (segments.length > 1 && /^(p|product|products|item|details|dp)$/i.test(segments[segments.length - 1])) {
      segments.pop();
    }
    const last = (segments[segments.length - 1] ?? "").replace(/\.(html?|aspx|php|jsp)$/i, "");
    const numeric = /^\d{3,}$/.test(last)
      ? last
      : (/(\d{3,})(?:$|[-_.])/.exec(last)?.[1] ?? "");
    if (numeric) return `#${numeric}`;
    // A short alphanumeric SKU tail ("mgft4zm-a", "b0fqfl2g9x") reads as a ref;
    // a long marketing slug does not, so it yields nothing.
    if (/^[a-z0-9][a-z0-9._-]{2,15}$/i.test(last) && last.length <= 16) return `#${last.toUpperCase()}`;
  } catch {
    /* unparseable URL — no evidence, no label */
  }
  return "";
}

/**
 * AC4 — make same-merchant, same-price rows distinguishable. Only rows that
 * would otherwise look identical are touched: when a card carries ≥2 rows of
 * ONE merchant at the SAME price+currency and any of those rows has no label,
 * the unlabelled rows get their listing reference (else a stable ordinal).
 * A single row per merchant, or rows at different prices, are untouched —
 * the served payload keeps its existing labels verbatim.
 *
 * Pure and deterministic: same rows, same labels, every render. Runs at
 * collection time so every surface (card, PDP, AR/EN) reads one payload.
 */
export function distinguishSamePriceRows<T extends { merchant: string; price: number; currency: string; url: string; label?: string }>(
  rows: readonly T[],
): T[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = `${row.merchant.toLowerCase()}|${row.price}|${row.currency.trim().toUpperCase()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(index);
    else groups.set(key, [index]);
  });
  const labels = new Map<number, string>();
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const labelled = indices.some((i) => (rows[i].label ?? "") !== "");
    if (!labelled) continue; // rows already differ by price/other slots
    let ordinal = 0;
    for (const i of indices) {
      if ((rows[i].label ?? "") !== "") continue;
      ordinal += 1;
      labels.set(i, listingRefLabel(rows[i].url) || `#${ordinal}`);
    }
  }
  if (labels.size === 0) return [...rows];
  return rows.map((row, index) => {
    const label = labels.get(index);
    return label ? { ...row, label } : row;
  });
}
