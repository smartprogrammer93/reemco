// @vitest-environment jsdom
/**
 * REEA-1159 — the theme-preference persistence layer.
 *
 * Guards the three shipped behaviours: the cookie value is normalized (never
 * trusted raw), one action flips light <-> dark, and the write is a single
 * year-long SameSite=Lax cookie on path=/ — the same contract as the locale
 * preference, so a stored theme survives page changes and reloads and
 * overrides the OS on the next server render.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  THEME_COOKIE,
  nextTheme,
  normalizeThemeCookie,
  readThemeCookie,
  rememberTheme,
  resetThemePrefs,
} from "@/lib/theme";

beforeEach(() => {
  resetThemePrefs();
});

describe("normalizeThemeCookie", () => {
  it("accepts only the two shipped themes, case- and space-insensitively", () => {
    expect(normalizeThemeCookie("dark")).toBe("dark");
    expect(normalizeThemeCookie(" LIGHT ")).toBe("light");
  });

  it("treats anything else as 'no explicit choice' so the OS keeps governing", () => {
    expect(normalizeThemeCookie(undefined)).toBeNull();
    expect(normalizeThemeCookie("")).toBeNull();
    expect(normalizeThemeCookie("system")).toBeNull();
    expect(normalizeThemeCookie("blue")).toBeNull();
    expect(normalizeThemeCookie(null)).toBeNull();
  });
});

describe("nextTheme", () => {
  it("always yields the opposite theme in one action", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });
});

describe("rc_theme cookie persistence", () => {
  it("writes a year-long path=/ SameSite=Lax cookie and reads it back", () => {
    rememberTheme("dark");
    expect(document.cookie).toContain(`${THEME_COOKIE}=dark`);
    expect(readThemeCookie()).toBe("dark");
    rememberTheme("light");
    expect(readThemeCookie()).toBe("light");
  });

  it("resetThemePrefs clears the stored choice", () => {
    rememberTheme("dark");
    resetThemePrefs();
    expect(readThemeCookie()).toBeNull();
  });
});
