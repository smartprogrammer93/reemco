// @vitest-environment jsdom
/**
 * REEA-1276 — the false-empty escape tail must never split.
 *
 * QA found that at 375 EN in the empty-shelf (case b) panel the escape wrapped
 * to two lines with a dangling "—" on line 1 and "Show all" on line 2: the
 * separator and the action were sibling flex items, so the row wrapped between
 * them. The fix puts both in ONE non-wrapping tail unit.
 *
 * jsdom has no layout engine, so this pins the mechanism rather than pixels:
 * the separator and the reveal control share a single `rc-hidden-escape-tail`
 * ancestor, which is a single flex item of the sentence. The painted result
 * (one line at 375 EN, AR and 1280 unchanged, 44px control intact, no
 * horizontal overflow) is measured in the browser probe on the served build.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParams = new URLSearchParams();
const routerSpies = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
  useRouter: () => routerSpies,
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ResultsClient from "@/components/ResultsClient";
import { resetStockPrefs } from "@/lib/stock";
import { resetCountryPrefs } from "@/lib/country";
import { resetLocalePrefs } from "@/lib/i18n";
import type { NormalizedProduct } from "@/types/product";

beforeEach(() => {
  searchParams.set("q", "panadol");
  searchParams.delete("c");
  searchParams.delete("oos");
  resetStockPrefs();
  resetCountryPrefs();
  resetLocalePrefs();
  vi.stubGlobal("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    sendBeacon: () => true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OOS = {
  merchant: "Sultan Center",
  price: 0.67,
  currency: "KWD",
  url: "https://sultan.example/p",
  inStock: false,
};

function hiddenOnlyProduct(): NormalizedProduct {
  return {
    productId: "panadrex-24",
    title: "Panadrex 24 Tablets",
    brand: "",
    offers: [OOS],
    coupons: [],
    variations: [],
    alternatives: [],
    productScope: "primary",
    matchReason: "brand_family",
  };
}

const escapeLine = () => document.querySelector('[data-hidden-matches="true"]') as HTMLElement | null;
const emptyState = () => document.querySelector('[data-empty-state="true"]') as HTMLElement | null;

async function renderEscape(locale?: "en" | "ar") {
  await act(async () => {
    render(<ResultsClient query="panadol" page={1} products={[hiddenOnlyProduct()]} country="KW" {...(locale ? { locale } : {})} />);
  });
  const line = escapeLine();
  expect(line).not.toBeNull();
  expect(emptyState()?.getAttribute("data-empty-case")).toBe("b");
  return line as HTMLElement;
}

function tailOf(line: HTMLElement) {
  const sep = line.querySelector(".rc-hidden-escape-sep") as HTMLElement | null;
  const reveal = line.querySelector('[data-hidden-reveal="stock"]') as HTMLElement | null;
  expect(sep).not.toBeNull();
  expect(reveal).not.toBeNull();
  return { sep: sep as HTMLElement, reveal: reveal as HTMLElement };
}

describe("REEA-1276 — separator + action are one non-splitting tail", () => {
  it("keeps the EN separator and 'Show all' in the same nowrap tail unit", async () => {
    const line = await renderEscape();
    const { sep, reveal } = tailOf(line);
    const tail = sep.parentElement;
    // One shared parent for both -> a flex row can never break between them.
    expect(tail).toBe(reveal.parentElement);
    expect(tail?.className).toBe("rc-hidden-escape-tail");
    expect(tail?.getAttribute("data-hidden-escape-tail")).toBe("true");
    expect(tail?.tagName).toBe("SPAN");
    // The tail is a direct child of the sentence paragraph (a single flex item).
    expect(tail?.parentElement?.tagName).toBe("P");
    expect(tail?.parentElement?.parentElement).toBe(line);
    // Copy is unchanged by the fix.
    expect(line.textContent).toContain("1 match hidden by In stock");
    expect(line.textContent).toContain("— Show all");
    expect(reveal.tagName).toBe("BUTTON");
  });

  it("keeps the AR separator and 'أظهر الكل' in the same tail unit", async () => {
    const line = await renderEscape("ar");
    const { sep, reveal } = tailOf(line);
    expect(sep.parentElement).toBe(reveal.parentElement);
    expect(sep.parentElement?.className).toBe("rc-hidden-escape-tail");
    expect(line.textContent).toContain("1 نتيجة مخفية بسبب متوفر");
    expect(line.textContent).toContain("— أظهر الكل");
    expect(reveal.textContent).toBe("أظهر الكل");
  });
});
