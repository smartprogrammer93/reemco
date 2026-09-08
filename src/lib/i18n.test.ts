// @vitest-environment jsdom
/**
 * REEA-279 — the EN/AR chrome chain behind the toggle. Guards the four
 * shipped behaviors: the preference precedence (cookie → coarse
 * Accept-Language hint → "en"), the q-weighted hint walk, the static-table
 * parity (both dictionaries expose exactly the same keys, Arabic included —
 * a missing key must never fall through silently), and the cookie-only
 * persistence the toggle writes. No machine translation anywhere: every
 * rendered string comes from these two literal tables.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCALE_COOKIE,
  clientLocale,
  fill,
  getStrings,
  localeDir,
  localeFromAcceptLanguage,
  readLocaleCookie,
  rememberLocale,
  resetLocalePrefs,
  resolveUiLocale,
} from "@/lib/i18n";

describe("resolveUiLocale precedence (REEA-279)", () => {
  it("the explicit cookie wins over the browser hint", () => {
    expect(resolveUiLocale("ar", "en-US,en;q=0.9")).toBe("ar");
    expect(resolveUiLocale("en", "ar-KW")).toBe("en");
  });

  it("a missing or unknown cookie falls through to the hint, then to en", () => {
    expect(resolveUiLocale(undefined, "ar-KW")).toBe("ar");
    expect(resolveUiLocale("fr", "ar-EG")).toBe("ar");
    expect(resolveUiLocale(undefined, null)).toBe("en");
    expect(resolveUiLocale("", undefined)).toBe("en");
  });

  it("the cookie value is normalized, not trusted raw", () => {
    expect(resolveUiLocale(" AR ", null)).toBe("ar");
  });
});

describe("localeFromAcceptLanguage — coarse q-weighted hint", () => {
  it("walks locales by descending q, not list order", () => {
    expect(localeFromAcceptLanguage("en-US;q=0.8,ar-KW;q=0.9")).toBe("ar");
    expect(localeFromAcceptLanguage("ar-EG;q=0.5,en-GB;q=0.7")).toBe("en");
  });

  it("ignores region subtags and skips unheld languages", () => {
    expect(localeFromAcceptLanguage("fr-FR,ar-KW;q=0.6")).toBe("ar");
    expect(localeFromAcceptLanguage("hi-IN,fr")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });

  it("keeps list order on equal weights (stable)", () => {
    expect(localeFromAcceptLanguage("ar,en;q=1")).toBe("ar");
  });
});

describe("static string table parity (REEA-279 AC-2)", () => {
  it("both dictionaries expose exactly the same keys", () => {
    const enKeys = Object.keys(getStrings("en"));
    const arKeys = Object.keys(getStrings("ar"));
    expect(arKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(40);
  });

  it("values are plain literals — chrome renders word-for-word from the table", () => {
    expect(getStrings("en").searchButton).toBe("Search");
    expect(getStrings("ar").searchButton).toBe("بحث");
    expect(getStrings("ar").inStock).toBe("متوفر");
  });

  it("fill substitutes the named slots", () => {
    expect(fill("Checking {x}…", { x: "Jarir" })).toBe("Checking Jarir…");
    expect(fill("UPDATED {n} MINUTES AGO", { n: 3 })).toBe("UPDATED 3 MINUTES AGO");
  });
});

describe("localeDir mirrors the layout with the toggle", () => {
  it("ar is RTL, en is LTR", () => {
    expect(localeDir("ar")).toBe("rtl");
    expect(localeDir("en")).toBe("ltr");
  });
});

describe("cookie-only persistence (REEA-279 AC-1)", () => {
  beforeEach(() => resetLocalePrefs());
  afterEach(() => resetLocalePrefs());

  it("rememberLocale round-trips through readLocaleCookie", () => {
    expect(readLocaleCookie()).toBeNull();
    rememberLocale("ar");
    expect(readLocaleCookie()).toBe("ar");
    rememberLocale("en");
    expect(readLocaleCookie()).toBe("en");
  });

  it("the preference rides the single rc_locale cookie only", () => {
    rememberLocale("ar");
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=ar`);
    expect(localStorage.length).toBe(0);
  });

  it("clientLocale follows the cookie, defaulting to en without one", () => {
    rememberLocale("ar");
    expect(clientLocale()).toBe("ar");
    resetLocalePrefs();
    expect(clientLocale()).toBe("en");
  });
});
