/**
 * REEA-400 — per-query SEO title + meta description for the /results surface.
 *
 * Every results query already lands on its own URL (/results?q=…); this
 * module makes that URL its own indexed landing surface by putting the query
 * into the document title ("<query> prices in <country> - Reemco", Arabic:
 * "أسعار <query> في الكويت - ريمكو") plus a short matching description.
 * The strings live in the shared static i18n table (REEA-279 pattern), so
 * locale selection is the one existing chain: rc_locale cookie → coarse
 * Accept-Language hint → "en". No machine translation, no bundled catalog —
 * pure string composition over the request's own params.
 *
 * Country label follows the existing market resolution (REEA-170/280 chain:
 * `?c=` → rc_market cookie → Accept-Language region hint). With no stated
 * market the company's home market label is used ("Kuwait" / "الكويت"),
 * matching the Arabic pattern in the brief. An empty query keeps a generic
 * per-country title instead of a query-less duplicate of the homepage copy.
 */
import { COUNTRY_OPTIONS, type CountryCode } from "./country";
import { fill, getStrings, type Locale } from "./i18n";

export interface ResultsMeta {
  title: string;
  description: string;
}

/** Market code → localized label from the same static table the pills use. */
function countryLabel(country: CountryCode | null, locale: Locale): string {
  const t = getStrings(locale);
  if (!country) return t.countryKW; // home-market default (brief's Arabic pattern)
  const option = COUNTRY_OPTIONS.find((o) => o.code === country);
  if (!option) return t.countryKW;
  if (option.code === "SA") return t.countrySA;
  if (option.code === "EG") return t.countryEG;
  return t.countryKW;
}

/** Build the query/locale-scoped title + description. Pure — the page's
 *  generateMetadata feeds it the sanitized `q`, the resolved country and the
 *  resolved UI locale, and nothing else. */
export function buildResultsMeta(args: {
  query: string;
  country: CountryCode | null;
  locale: Locale;
}): ResultsMeta {
  const t = getStrings(args.locale);
  const countryText = countryLabel(args.country, args.locale);
  // No query stated → name the market scope, not an empty placeholder.
  const queryText = args.query.trim() !== "" ? args.query.trim() : t.allProducts;
  const values = { q: queryText, country: countryText };
  return {
    title: fill(t.metaTitle, values),
    description: fill(t.metaDescription, values),
  };
}
