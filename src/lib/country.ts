/**
 * REEA-170 — country filter for the search-results experience (KWD-first).
 *
 * One shared contract for the whole filter path so every surface derived
 * from offers honors the same selection:
 *  - each retailer adapter tags its live hits with a country (see
 *    src/lib/collect/live-search.ts); the server filters hits right before
 *    grouping, so main prices, availability, retailer counts, best-price
 *    flags and cheaper alternatives are ALL computed from the filtered set;
 *  - the bundled static-export fallback feed (catalog offers) carries only a
 *    currency, so client-side filtering maps currency → country there.
 *
 * Persistence follows the app's existing preference/store mechanism (REEA-84
 * same-tab pattern in useCollection.ts): the ACTIVE choice rides on the URL
 * (`/results?q=…&c=KW`) and the remembered choice lives in a module-level
 * slot that survives client-side navigations within the tab session — no
 * cookies / localStorage / cross-session ids, matching the telemetry and
 * collection-cache conventions. A new search picks the value up through the
 * hidden input in SearchForm, so the selection carries over without being
 * re-selected.
 *
 * Graceful degradation: with no selection (null) every offer matches and
 * behavior is identical to the pre-feature page.
 */
import type { NormalizedProduct } from "@/types/product";

export const COUNTRY_OPTIONS = [
  { code: "KW", label: "Kuwait", currency: "KWD" },
  { code: "SA", label: "Saudi Arabia", currency: "SAR" },
  { code: "EG", label: "Egypt", currency: "EGP" },
] as const;

export type CountryCode = (typeof COUNTRY_OPTIONS)[number]["code"];

/** Allowlisted normalize of the `?c=` search param; anything else → All. */
export function sanitizeCountry(raw: unknown): CountryCode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return COUNTRY_OPTIONS.find((o) => o.code === v)?.code ?? null;
}

/**
 * Currency → country mapping for offer surfaces that only carry a currency
 * (catalog feed offers, LiveOffer rows). Mirrors the adapter tags: KWD stores
 * answer from Kuwait, jarir.com from Saudi Arabia, amazon.eg from Egypt.
 */
const CURRENCY_COUNTRY: Record<string, CountryCode> = {
  KWD: "KW",
  SAR: "SA",
  EGP: "EG",
};

export function countryForCurrency(currency: string): CountryCode | null {
  return CURRENCY_COUNTRY[currency.trim().toUpperCase()] ?? null;
}

/** True when the offer belongs to the selection; no selection always matches. */
export function matchesCountry(country: CountryCode | null, currency: string): boolean {
  if (!country) return true;
  return countryForCurrency(currency) === country;
}

/** Offers visible under the selection, order preserved. */
export function filterOffersByCountry<T extends { currency: string }>(
  offers: T[],
  country: CountryCode | null,
): T[] {
  if (!country) return offers;
  return offers.filter((o) => matchesCountry(country, o.currency));
}

/**
 * Apply the selection to a normalized-product list client-side. On the live
 * server path the offers are already filtered before grouping (this is then
 * an idempotent pass); on the static-host catalog fallback this is the filter.
 * Alternative `fromPrice` figures are recomputed from the filtered offers of
 * the referenced product, and alternatives left with no matching offer are
 * dropped — everything derived from offers honors the selection.
 */
export function filterProductsByCountry(
  products: NormalizedProduct[],
  country: CountryCode | null,
): NormalizedProduct[] {
  if (!country) return products;
  return products.map((p) => {
    const offers = filterOffersByCountry(p.offers, country);
    const alternatives = p.alternatives.flatMap((a) => {
      const alt = products.find((x) => x.productId === a.productId);
      if (!alt) return [a];
      const altOffers = filterOffersByCountry(alt.offers, country);
      if (altOffers.length === 0) return [];
      return [{ ...a, fromPrice: Math.min(...altOffers.map((o) => o.price)) }];
    });
    return { ...p, offers, alternatives };
  });
}

/** Build the results URL the pills and carry-over links share. */
export function buildResultsHref(query: string, page: number, country: CountryCode | null): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (country) params.set("c", country);
  const qs = params.toString();
  return qs ? `/results?${qs}` : "/results";
}

/* ---- Same-tab remembered selection (existing module-slot pattern). ---- */

let rememberedCountry: CountryCode | null = null;

/** Pill clicks record the choice for the next search's hidden input. */
export function rememberCountry(code: CountryCode | null): void {
  rememberedCountry = code;
}

export function recallCountry(): CountryCode | null {
  return rememberedCountry;
}

/** Test support: deterministic starting point across cases. */
export function resetCountryPrefs(): void {
  rememberedCountry = null;
}
