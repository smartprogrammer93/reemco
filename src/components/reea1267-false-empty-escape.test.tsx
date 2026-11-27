// @vitest-environment jsdom
/**
 * REEA-1267 (Bet 2) — the false-empty escape contract.
 *
 * These pins are the shopper-visible promise from the ticket: an active filter
 * must never hide a confident in-scope match behind a "no match" claim, the
 * count on the one-line escape is the TRUE hidden count computed from the
 * payload's own scope decision (the same painted shelf chain the renderer
 * uses), the one-tap reveal shows exactly those cards, and a `related` /
 * `consumable` row is never promoted into the count (F-1/F-2, EN+AR).
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
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
import { hiddenMatchReport, hiddenShelfMatches } from "@/lib/hidden-matches";
import { resetStockPrefs } from "@/lib/stock";
import { resetCountryPrefs } from "@/lib/country";
import { resetLocalePrefs } from "@/lib/i18n";
import type { NormalizedProduct } from "@/types/product";

beforeEach(() => {
  searchParams.set("q", "");
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
const IN_STOCK = {
  merchant: "Xcite",
  price: 0.75,
  currency: "KWD",
  url: "https://xcite.example/p",
  inStock: true,
};

function product(
  productId: string,
  title: string,
  offers: NormalizedProduct["offers"],
  scope?: NormalizedProduct["productScope"],
  reason?: NormalizedProduct["matchReason"],
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    ...(scope ? { productScope: scope } : {}),
    ...(reason ? { matchReason: reason } : {}),
  };
}

const escapeLine = () => document.querySelector('[data-hidden-matches="true"]') as HTMLElement | null;
const emptyState = () => document.querySelector('[data-empty-state="true"]') as HTMLElement | null;
const cardIds = () =>
  Array.from(document.querySelectorAll("[data-product-id]")).map((n) => n.getAttribute("data-product-id"));

describe("F-1/F-2 — the hidden set is the payload's confident in-scope set", () => {
  it("counts a scope-primary card the confidence ladder alone would miss", () => {
    // Live shape (`panadol`): the relevance gate stamps `brand_family` primary
    // for "Panadrex", but the old pre-7A confidence ladder scored it 0. The
    // shelf painted it; the escape must count it — otherwise the page says
    // "No match found" while holding it (the false-empty this ticket fixes).
    const panadrex = product(
      "panadrex-24",
      "Panadrex 24 Tablets",
      [OOS],
      "primary",
      "brand_family",
    );
    const hidden = hiddenShelfMatches([panadrex], "panadol", 1, "KW", false);
    expect(hidden.cards.map((p) => p.productId)).toEqual(["panadrex-24"]);
    expect(hiddenMatchReport([panadrex], "panadol", "KW", false)).toEqual({
      stock: 1,
      country: 0,
    });
  });

  it("never promotes a related/consumable row into the hidden count", () => {
    // Live shape (`coffee machine`): "Nescafe Gold Coffee 200g" is a
    // consumable-scope row (the related band), and the confidence ladder
    // scored it 2. It is NOT a result card, so it must never be counted as a
    // hidden match (F-2: no related-band item promoted).
    const coffee = product(
      "nescafe-gold",
      "Nescafe Gold Coffee 200g",
      [OOS],
      "consumable",
      "related",
    );
    expect(hiddenShelfMatches([coffee], "coffee machine", 1, "KW", false).cards).toEqual([]);
    expect(hiddenMatchReport([coffee], "coffee machine", "KW", false)).toEqual({
      stock: 0,
      country: 0,
    });
  });

  it("renders the one-line escape instead of 'No match found' when the filter hides the only match", async () => {
    searchParams.set("q", "panadol");
    const panadrex = product("panadrex-24", "Panadrex 24 Tablets", [OOS], "primary", "brand_family");
    await act(async () => {
      render(<ResultsClient query="panadol" page={1} products={[panadrex]} country="KW" />);
    });
    const card = emptyState();
    expect(card?.getAttribute("data-empty-case")).toBe("b");
    const line = escapeLine();
    expect(line).not.toBeNull();
    expect(line?.getAttribute("data-hidden-count")).toBe("1");
    expect(line?.getAttribute("data-hidden-filter")).toBe("stock");
    expect(line?.textContent).toContain("1 match hidden by In stock");
    expect(line?.textContent).toContain("— Show all");
    expect(document.body.textContent).not.toContain("Check the spelling");
    // The one-tap control is a real button, not a link that reloads.
    const reveal = line?.querySelector('[data-hidden-reveal="stock"]') as HTMLElement;
    expect(reveal.tagName).toBe("BUTTON");
  });

  it("reveals exactly the payload cards the count claimed — no fabricated rows (F-2)", async () => {
    searchParams.set("q", "panadol");
    const panadrex = product("panadrex-24", "Panadrex 24 Tablets", [OOS], "primary", "brand_family");
    const panadolIn = product("panadol-24", "Panadol Extra 24 Tablets", [IN_STOCK], "primary", "query_token");
    await act(async () => {
      render(
        <ResultsClient query="panadol" page={1} products={[panadolIn, panadrex]} country="KW" />,
      );
    });
    const line = escapeLine();
    expect(line?.getAttribute("data-hidden-count")).toBe("1");
    await act(async () => {
      fireEvent.click(line?.querySelector('[data-hidden-reveal="stock"]') as HTMLElement);
    });
    expect(escapeLine()).toBeNull();
    expect(cardIds().sort()).toEqual(["panadol-24", "panadrex-24"]);
    expect(window.location.search).toContain("q=panadol");
    expect(window.location.search).toContain("stock=all");
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  it("keeps the escape on a partially hidden shelf, above the visible cards", async () => {
    searchParams.set("q", "panadol");
    const panadolIn = product("panadol-24", "Panadol Extra 24 Tablets", [IN_STOCK], "primary", "query_token");
    const panadrex = product("panadrex-24", "Panadrex 24 Tablets", [OOS], "primary", "brand_family");
    await act(async () => {
      render(
        <ResultsClient query="panadol" page={1} products={[panadolIn, panadrex]} country="KW" />,
      );
    });
    expect(emptyState()).toBeNull();
    const line = escapeLine();
    expect(line?.getAttribute("data-hidden-count")).toBe("1");
    // The line precedes the visible card in document order (above the fold).
    const firstCard = document.querySelector("[data-product-id]") as HTMLElement;
    expect(line!.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders nothing when the filter hides nothing (genuine no-match keeps its copy)", async () => {
    searchParams.set("q", "zzzzqqq");
    await act(async () => {
      render(<ResultsClient query="zzzzqqq" page={1} products={[]} />);
    });
    expect(escapeLine()).toBeNull();
    const card = emptyState();
    expect(card?.getAttribute("data-empty-case")).toBe("a");
    expect(card?.textContent).toContain("No match found");
  });
});

describe("F-1 — Arabic parity for the escape", () => {
  it("renders the AR one-line escape and the AR reveal action", async () => {
    searchParams.set("q", "panadol");
    const panadrex = product("panadrex-24", "Panadrex 24 Tablets", [OOS], "primary", "brand_family");
    await act(async () => {
      render(
        <ResultsClient query="panadol" page={1} products={[panadrex]} country="KW" locale="ar" />,
      );
    });
    const line = escapeLine();
    expect(line?.getAttribute("data-hidden-count")).toBe("1");
    expect(line?.textContent).toContain("1 نتيجة مخفية بسبب متوفر");
    expect(line?.textContent).toContain("— أظهر الكل");
    const reveal = line?.querySelector('[data-hidden-reveal="stock"]') as HTMLElement;
    expect(reveal.textContent).toBe("أظهر الكل");
    expect(document.body.textContent).not.toContain("تحقق من الإملاء");
  });
});
