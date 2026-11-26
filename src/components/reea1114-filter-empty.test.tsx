// @vitest-environment jsdom
/**
 * REEA-1114 — the filter-aware empty state. These pins are the shopper-visible
 * contract from the ticket: a zero visible set that an ACTIVE filter hid must
 * never say "no match found", must name the filter and the count, and must
 * reveal the rows in place without losing the query (AC1–AC4). The genuine
 * no-match and the outage keep their existing copy (AC2 a/c).
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
import { resetStockPrefs } from "@/lib/stock";
import { resetCountryPrefs } from "@/lib/country";
import { resetLocalePrefs } from "@/lib/i18n";
import type { LiveSearchResult } from "@/lib/collect/live-search";
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

function product(
  productId: string,
  title: string,
  offers: NormalizedProduct["offers"],
): NormalizedProduct {
  return {
    productId,
    title,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

const PANADOL_OOS = product("panadol-24", "Panadol Pain Relief Tablets 24Tablets", [
  {
    merchant: "Sultan Center",
    price: 0.67,
    currency: "KWD",
    url: "https://sultan.example/p",
    inStock: false,
  },
]);
const PANADOL_SAR = product("panadol-24", "Panadol Pain Relief Tablets 24Tablets", [
  {
    merchant: "Danube Home",
    price: 5.8,
    currency: "SAR",
    url: "https://danube.example/p",
    inStock: true,
  },
]);
const PANADOL_IN = product("panadol-in", "Panadol Pain Relief Tablets 24Tablets", [
  {
    merchant: "Xcite",
    price: 0.75,
    currency: "KWD",
    url: "https://xcite.example/p",
    inStock: true,
  },
]);

const emptyState = () => document.querySelector('[data-empty-state="true"]');
const chips = () =>
  Array.from(
    document.querySelectorAll('[role="group"][aria-label] button'),
  ) as HTMLElement[];

describe("REEA-1114 AC1/AC3 — the In stock filter hid the matches", () => {
  it("names the filter and the count, offers the reveal, and keeps the spelling copy out", async () => {
    searchParams.set("q", "panadol");
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[PANADOL_OOS]}
          country="KW"
        />,
      );
    });
    const card = emptyState() as HTMLElement;
    expect(card.getAttribute("data-empty-case")).toBe("b");
    expect(card.textContent).toContain("1 match hidden by In stock");
    expect(card.textContent).not.toContain("Check the spelling");
    // AC2 — the "try a shorter phrase" hint must not contradict the card.
    expect(document.body.textContent).not.toContain("No matches — try a shorter phrase.");
    // AC3 — the chip carries the count before the shopper reaches the card.
    const inStock = chips().find((b) => b.textContent?.includes("In stock")) as HTMLElement;
    expect(inStock.textContent).toContain("1 hidden");
    expect(inStock.getAttribute("aria-pressed")).toBe("true");
    expect(inStock.getAttribute("aria-label")).toBe("In stock, 1 hidden by this filter");
    // AC1 — the pinned action label.
    const reveal = card.querySelector('[data-empty-reveal="stock"]') as HTMLElement;
    expect(reveal.textContent).toBe("Show out-of-stock");
  });

  it("reveals the hidden match in place: no reload, query kept, URL echoed (AC4)", async () => {
    searchParams.set("q", "panadol");
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[PANADOL_OOS]}
          country="KW"
        />,
      );
    });
    expect(document.body.textContent).not.toContain("Panadol Pain Relief Tablets 24Tablets");
    const reveal = emptyState()?.querySelector('[data-empty-reveal="stock"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(reveal);
    });
    // The card is on screen now, still on /results with the shopper's query.
    expect(document.body.textContent).toContain("Panadol Pain Relief Tablets 24Tablets");
    expect(document.querySelector('[data-empty-state="true"]')).toBeNull();
    expect(window.location.search).toContain("q=panadol");
    expect(window.location.search).toContain("stock=all");
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.refresh).not.toHaveBeenCalled();
    // The chip flips with the reveal — the filter is no longer hiding rows.
    const inStock = chips().find((b) => b.textContent?.includes("In stock")) as HTMLElement;
    expect(inStock.getAttribute("aria-pressed")).toBe("false");
    expect(inStock.textContent).not.toContain("hidden");
  });

  it("ranks by effective price after the reveal (Bet 6a AC4)", async () => {
    searchParams.set("q", "panadol");
    const first = product("a-first", "Panadol Pain Relief Tablets 24Tablets", [
      { merchant: "Sultan Center", price: 0.9, currency: "KWD", url: "https://a", inStock: false },
    ]);
    const second = product("b-second", "Panadol Extra Pain Relief Tablets 24tablets", [
      { merchant: "Sultan Center", price: 0.4, currency: "KWD", url: "https://b", inStock: false },
    ]);
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[first, second]}
          country="KW"
        />,
      );
    });
    const card = emptyState() as HTMLElement;
    expect(card.textContent).toContain("2 matches hidden by In stock");
    await act(async () => {
      fireEvent.click(card.querySelector('[data-empty-reveal="stock"]') as HTMLElement);
    });
    const titles = Array.from(document.querySelectorAll("article.result-card h3, article.result-card .rc-card-title")).map(
      (n) => n.textContent,
    );
    // REEA-1177 AC 6a-4 — the primary shelf now ranks by effective price, so
    // the cheaper product leads the revealed shelf.
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Panadol Extra Pain Relief Tablets 24tablets")).toBeLessThan(
      text.indexOf("Panadol Pain Relief Tablets 24Tablets"),
    );
    expect(titles.length).toBeGreaterThan(0);
  });
});

describe("REEA-1142 supersedes the market-hidden empty state", () => {
  it("keeps the cross-market card visible and labeled instead of an empty shelf", async () => {
    // The live `panadol` case: every offer is a danube.sa SAR listing. The
    // accepted policy keeps the lane, labels the row ("Saudi price") and
    // renders the honest "No Kuwait offer" headline — the page is no longer
    // empty, so the market filter has nothing to reveal.
    searchParams.set("q", "panadol");
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[PANADOL_SAR]}
          country="KW"
        />,
      );
    });
    expect(emptyState()).toBeNull();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Panadol Pain Relief Tablets 24Tablets");
    expect(body).toContain("Saudi price");
    expect(body).toContain("No Kuwait offer");
    // The row still carries its real price (formatting may use a
    // non-breaking space, so pin the figure).
    expect(body).toContain("5.80");
    expect(window.location.search).toContain("q=panadol");
  });
});

describe("REEA-1114 AC2 — the other two cases keep their copy", () => {
  it("a genuine no-match keeps 'No match found' + the spelling line + the hint", async () => {
    searchParams.set("q", "zzzzqqq");
    await act(async () => {
      render(<ResultsClient query="zzzzqqq" page={1} products={[]} />);
    });
    const card = emptyState() as HTMLElement;
    expect(card.getAttribute("data-empty-case")).toBe("a");
    expect(card.textContent).toContain("No match found");
    expect(card.textContent).toContain("Check the spelling or try a broader search term.");
    expect(document.body.textContent).toContain("No matches — try a shorter phrase.");
    expect(card.querySelector("[data-empty-reveal]")).toBeNull();
  });

  it("a failed collection keeps the existing outage copy and drops the spelling hint", async () => {
    searchParams.set("q", "wh-1000xm6");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => null })));
    const down: LiveSearchResult = {
      products: [],
      notes: [
        { merchant: "Xcite", hits: 0, error: "no answer within the completion budget" },
        { merchant: "Jarir", hits: 0, error: "HTTP 503" },
      ],
    };
    await act(async () => {
      render(
        <ResultsClient
          query="wh-1000xm6"
          page={1}
          country={null}
          stages={[Promise.resolve(down), Promise.resolve(down)]}
        />,
      );
    });
    const card = emptyState() as HTMLElement;
    expect(card.getAttribute("data-empty-case")).toBe("c");
    expect(card.textContent).toContain("The stores didn’t answer this time");
    expect(card.textContent).not.toContain("Check the spelling");
    expect(document.body.textContent).not.toContain("No matches — try a shorter phrase.");
  });
});

describe("REEA-1114 AC5 — Arabic parity", () => {
  it("renders the AR hidden-match title and the pinned AR reveal action", async () => {
    searchParams.set("q", "panadol");
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[PANADOL_OOS]}
          country="KW"
          locale="ar"
        />,
      );
    });
    const card = emptyState() as HTMLElement;
    expect(card.getAttribute("data-empty-case")).toBe("b");
    expect(card.textContent).toContain("1 نتيجة مخفية بسبب متوفر");
    expect(card.textContent).not.toContain("تحقق من الإملاء");
    const reveal = card.querySelector('[data-empty-reveal="stock"]') as HTMLElement;
    expect(reveal.textContent).toBe("أظهر غير المتوفر");
    const inStock = chips().find((b) => b.textContent?.includes("متوفر")) as HTMLElement;
    expect(inStock.textContent).toContain("مخفية");
  });

  it("renders the AR cross-market label and no-local-offer headline", async () => {
    searchParams.set("q", "panadol");
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[PANADOL_SAR]}
          country="KW"
          locale="ar"
        />,
      );
    });
    expect(emptyState()).toBeNull();
    const body = document.body.textContent ?? "";
    expect(body).toContain("سعر السعودية");
    expect(body).toContain("لا يوجد عرض في الكويت");
  });
});

describe("REEA-1114 AC3 — a partially hidden shelf still shows the count", () => {
  it("keeps the visible card and shows the hidden count on the chip", async () => {
    searchParams.set("q", "panadol");
    await act(async () => {
      render(
        <ResultsClient
          query="panadol"
          page={1}
          products={[PANADOL_IN, PANADOL_OOS]}
          country="KW"
        />,
      );
    });
    // One visible card, so this is not an empty state…
    expect(document.querySelector('[data-empty-state="true"]')).toBeNull();
    expect(document.body.textContent).toContain("Panadol Pain Relief Tablets 24Tablets");
    // …but the chip still reports the row the filter is hiding.
    const inStock = chips().find((b) => b.textContent?.includes("In stock")) as HTMLElement;
    expect(inStock.textContent).toContain("1 hidden");
  });
});
