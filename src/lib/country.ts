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
 * slot that survives client-side navigations within the tab session. A new
 * search picks the value up through the hidden input in SearchForm, so the
 * selection carries over without being re-selected.
 *
 * REEA-280 layers two things on top of that contract:
 *  - a DEFAULT market derived from the coarse Accept-Language hint when the
 *    shopper has stated nothing else (ar-KW/en-KW → Kuwait/KWD; ar-SA →
 *    Saudi/SAR; ar-EG/en-EG → Egypt/EGP). Unmapped locales keep the old
 *    "All" behavior — the hint only picks among the three existing tabs;
 *  - the one-tap pill choice persists across sessions through a SINGLE
 *    language-preference cookie (`rc_market`) — the only persistent storage
 *    the app keeps; it holds nothing but the shopper's own market pick
 *    (or an explicit "ALL" for the All tab).
 * Resolution order everywhere: explicit `?c=` → the cookie → the header hint.
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

/** Country selection → its currency code — the lead figure's space on price
 *  rows (REEA-283): SA→SAR, KW→KWD, EG→EGP. */
export function currencyForCountry(code: CountryCode): string {
  return COUNTRY_OPTIONS.find((o) => o.code === code)?.currency ?? "KWD";
}

/* ---- REEA-280 — locale-aware market default + one persisted preference. ---- */

/** The single language-preference cookie. No other persistent storage. */
export const MARKET_COOKIE = "rc_market";
/** A year: a deliberate market pick outlives the session it was made in. */
const MARKET_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Normalize the cookie value. `ALL` is the explicit All-tab choice — it
 * reads back as the plain null ("match every offer") selection; unknown or
 * absent values read as null so the next hint layer still applies.
 */
export function normalizeMarketCookie(raw: unknown): CountryCode | "ALL" | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (v === "ALL") return "ALL";
  return sanitizeCountry(v);
}

/** Region-subtag → tab map. Coarse on purpose (AC-2): only the region
 *  decides, and only the three served markets map. */
const REGION_COUNTRY: Record<string, CountryCode> = { KW: "KW", SA: "SA", EG: "EG" };

/**
 * Coarse Accept-Language hint (REEA-280 AC-2): walk the header's locales in
 * weight order (q descending, stable on equal q, exactly as RFC 9110 orders
 * them) and take the first region subtag that maps to a served market. A
 * language-only tag ("ar", "en") carries no market signal and is skipped —
 * guessing past the explicit region would be profiling, not a hint. No match
 * keeps today's "All" behavior.
 */
export function countryFromAcceptLanguage(header: string | null | undefined): CountryCode | null {
  if (!header) return null;
  const entries: { country: CountryCode | null; q: number; order: number }[] = [];
  header.split(",").forEach((part, order) => {
    const segments = part.trim().split(";");
    const locale = segments[0]?.trim();
    if (!locale) return;
    let q = 1;
    for (const p of segments.slice(1)) {
      const m = /^q=(\d(?:\.\d+)?)$/i.exec(p.trim());
      if (m) q = Number(m[1]);
    }
    const region = locale.split("-")[1]?.toUpperCase();
    entries.push({
      country: region ? REGION_COUNTRY[region] ?? null : null,
      q: Number.isFinite(q) ? q : 1,
      order,
    });
  });
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  for (const e of entries) if (e.country) return e.country;
  return null;
}

/**
 * The one resolution chain every surface shares (REEA-280): explicit `?c=`
 * wins (it is the shopper's stated choice for THIS view — even `c=all`
 * counts, dropping to the unfiltered list); otherwise the persisted pill
 * choice from the language-preference cookie; otherwise the coarse header
 * hint. Unset at every layer keeps the pre-feature "All" behavior.
 */
export function resolveCountrySelection(
  rawParam: unknown,
  cookieRaw: unknown,
  acceptLanguage: string | null | undefined,
): CountryCode | null {
  const param = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof param === "string" && param.trim() !== "") return sanitizeCountry(param);
  const cookie = normalizeMarketCookie(cookieRaw);
  if (cookie === "ALL") return null;
  if (cookie) return cookie;
  return countryFromAcceptLanguage(acceptLanguage);
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

/** Build the results URL the pills and carry-over links share. REEA-186: the
 *  optional stock-selection flag rides along so alternatives/pill navigation
 *  keeps the shopper's "show out-of-stock" choice; unset keeps today's URLs. */
export function buildResultsHref(
  query: string,
  page: number,
  country: CountryCode | null,
  showOutOfStock = false,
): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (country) params.set("c", country);
  if (showOutOfStock) params.set("oos", "1");
  const qs = params.toString();
  return qs ? `/results?${qs}` : "/results";
}

/* ---- Remembered selection: same-tab slot + the one preference cookie. ---- */

let rememberedCountry: CountryCode | null = null;

/** Pill clicks record the choice for the next search's hidden input AND for
 *  the next visit: the same write lands in the single language-preference
 *  cookie (REEA-280 AC-2 — a one-tap SAR/EGP switch persists; clicking All
 *  persists the explicit unfiltered choice as `ALL`). The cookie write is
 *  guarded so non-browser hosts (vitest node env, prerender) stay on the
 *  module slot alone. */
export function rememberCountry(code: CountryCode | null): void {
  rememberedCountry = code;
  if (typeof document !== "undefined") {
    document.cookie = `${MARKET_COOKIE}=${code ?? "ALL"}; path=/; max-age=${MARKET_COOKIE_MAX_AGE}; SameSite=Lax`;
  }
}

/** The cookie read behind the same-tab slot: a returning tab (or a fresh
 *  page-load on the static-host fallback) picks the persisted choice up
 *  without re-selecting. */
export function readMarketCookie(): CountryCode | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${MARKET_COOKIE}=([^;]*)`));
  const value = normalizeMarketCookie(match?.[1]);
  return value === "ALL" ? null : value;
}

export function recallCountry(): CountryCode | null {
  return rememberedCountry ?? readMarketCookie();
}

/** Test support: deterministic starting point across cases. */
export function resetCountryPrefs(): void {
  rememberedCountry = null;
  if (typeof document !== "undefined") {
    document.cookie = `${MARKET_COOKIE}=; path=/; max-age=0`;
  }
}
