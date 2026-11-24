// @vitest-environment jsdom
/**
 * REEA-1159 — the header theme control.
 *
 * Guards the acceptance shape that is provable without a browser: the button
 * exists on the server render with an accessible name + aria-pressed (so the
 * first paint is SSR-safe and hydration has nothing to disagree with), one
 * activation flips <html data-theme> AND persists the choice, and the OS
 * preference is only consulted AFTER mount (never during render, so no #418).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ThemeToggle from "@/components/ThemeToggle";
import { resetThemePrefs, THEME_COOKIE } from "@/lib/theme";

type Mq = MediaQueryList;

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => false,
  } as unknown as Mq;
  window.matchMedia = ((q: string) => ({ ...mq, media: q })) as unknown as typeof window.matchMedia;
  return {
    mq,
    fire(next: boolean) {
      const event = { matches: next } as MediaQueryListEvent;
      listeners.forEach((cb) => cb(event));
    },
  };
}

beforeEach(() => {
  resetThemePrefs();
  delete document.documentElement.dataset.theme;
  stubMatchMedia(false);
});

afterEach(cleanup);

describe("ThemeToggle SSR shape (REEA-1159 AC3/AC4)", () => {
  it("is a real button with a state name and aria-pressed, before any client work", () => {
    const { getByRole } = render(<ThemeToggle locale="en" initialTheme={null} />);
    const btn = getByRole("button", { name: "Dark mode" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("type")).toBe("button");
    // Native <button> = keyboard operable; the CSS pins the 44px target.
    expect(btn.classList.contains("rc-icon-btn")).toBe(true);
    expect(btn.classList.contains("rc-theme-btn")).toBe(true);
    // No theme attribute on the server render: the OS media query governs.
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("renders the stored dark choice as pressed on the server pass", () => {
    const { getByRole } = render(<ThemeToggle locale="en" initialTheme="dark" />);
    const btn = getByRole("button", { name: "Dark mode" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Switch to light theme");
  });

  it("carries Arabic chrome with the same aria contract", () => {
    const { getByRole } = render(<ThemeToggle locale="ar" initialTheme="light" />);
    const btn = getByRole("button", { name: "الوضع الداكن" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("title")).toBe("التبديل إلى الوضع الداكن");
  });
});

describe("ThemeToggle interaction (REEA-1159 AC1/AC2)", () => {
  it("switches light -> dark in one action, sets data-theme and stores the choice", () => {
    const { getByRole } = render(<ThemeToggle locale="en" initialTheme={null} />);
    const btn = getByRole("button", { name: "Dark mode" });
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain(`${THEME_COOKIE}=dark`);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Switch to light theme");
  });

  it("switches dark -> light, overriding the OS preference", () => {
    stubMatchMedia(true);
    const { getByRole } = render(<ThemeToggle locale="en" initialTheme="dark" />);
    const btn = getByRole("button", { name: "Dark mode" });
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.cookie).toContain(`${THEME_COOKIE}=light`);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("resolves the OS preference after mount when no choice is stored", async () => {
    stubMatchMedia(true);
    const { getByRole } = render(<ThemeToggle locale="en" initialTheme={null} />);
    const btn = getByRole("button", { name: "Dark mode" });
    await waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("true"));
    // No attribute written: the shipped OS media query is what paints dark.
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.cookie).not.toContain(`${THEME_COOKIE}=`);
  });
});
