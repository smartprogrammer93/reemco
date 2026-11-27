// @vitest-environment jsdom
/**
 * REEA-1247 — the zero-offer page must be internally consistent and recover
 * the shopper with nearest in-market matches instead of unrelated accessories.
 *
 * The fixtures replay the live shapes measured 2026-11-27 on the served head
 * (`xyzzy no such thing`, `dyson airwrap case`, `sony wh-1000xm6 ear pads`):
 * zero primary-scope cards, related/accessory rows from the same live run, and
 * notes that answered with hits whose rows were filtered out of the shelf.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
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
import { resetCountryPrefs } from "@/lib/country";
import { resetLocalePrefs } from "@/lib/i18n";
import { resetStockPrefs } from "@/lib/stock";
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

const offer = (
  merchant: string,
  price: number,
  currency: string,
): NormalizedProduct["offers"][number] => ({
  merchant,
  price,
  currency,
  url: `https://${merchant.toLowerCase()}.example/p`,
  inStock: true,
  market: currency === "KWD" ? "KW" : "SA",
});

function card(
  id: string,
  title: string,
  scope: NormalizedProduct["productScope"],
  offers: NormalizedProduct["offers"],
): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "",
    offers,
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-11-27T00:00:00.000Z",
    productScope: scope,
  };
}

const XYZZY: LiveSearchResult = {
  products: [
    card("honor-pad", "HONOR Pad 20 Tablet", "consumable", [offer("Sultan Center", 0.175, "KWD"), offer("Switch", 114.9, "KWD")]),
    card("bizzy-bear", "Bizzy Bear: Snow Fun", "accessory", [offer("Jarir", 29, "SAR")]),
    card("legion-go", "Lenovo Legion Go Gen 2 Gaming Console", "accessory", [offer("Quadra Stores", 519.9, "KWD")]),
  ],
  notes: [
    { merchant: "Xcite", hits: 10 },
    { merchant: "Jarir", hits: 1 },
    { merchant: "Sultan Center", hits: 10 },
    { merchant: "Switch", hits: 10 },
    { merchant: "Eureka", hits: 0 },
    { merchant: "Amazon.eg", hits: 0, error: "no answer within the 1800 ms completion budget" },
  ],
  settled: true,
};

const DYSON: LiveSearchResult = {
  products: [
    card("dyson-airwrap", "Dyson Airwrap i.d. Multi-styler and dryer Straight+Wavy HS08", "accessory", [
      offer("Yousifi", 139.9, "KWD"),
      offer("Eureka", 139.95, "KWD"),
    ]),
    card("dyson-coanda", "Dyson Airwrap Co-anda2x Multi-styler & Dryer", "accessory", [offer("Ounass", 230, "KWD")]),
    card("kindle", "Kindle Paperwhite", "consumable", [offer("Jarir", 599, "SAR")]),
  ],
  notes: [
    { merchant: "Yousifi", hits: 8 },
    { merchant: "Eureka", hits: 2 },
    { merchant: "Ounass", hits: 3 },
  ],
  settled: true,
};

const SONY_FOREIGN: LiveSearchResult = {
  products: [
    card("sony-wi-c100", "Sony WI-C100 In-Ear Earphones", "accessory", [offer("Jarir", 99, "SAR")]),
    card("sony-wf-c510", "Sony WF-C510 Earbuds", "accessory", [offer("Jarir", 219, "SAR")]),
    card("dyson-airwrap", "Dyson Airwrap", "accessory", [offer("Yousifi", 139.9, "KWD")]),
  ],
  notes: [
    { merchant: "Jarir", hits: 24 },
    { merchant: "Yousifi", hits: 8 },
  ],
  settled: true,
};

function renderZero(snap: LiveSearchResult, query: string, locale: "en" | "ar") {
  searchParams.set("q", query);
  return render(
    <ResultsClient
      query={query}
      page={1}
      country="KW"
      showOutOfStock={false}
      locale={locale}
      stages={[Promise.resolve(snap), Promise.resolve(snap)]}
    />,
  );
}

describe("REEA-1247 AC1/AC2/AC3 — the xyzzy zero page is internally consistent", () => {
  it("does not claim stores 'carry this', drops 'Prices from' and the accessory band", async () => {
    await act(async () => {
      renderZero(XYZZY, "xyzzy no such thing", "en");
    });
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("No match found");
    expect(text).toContain("0 results for");
    // AC1 — the live defect was "12 carry this" above 0 rendered offers.
    expect(text).toContain("none carry this");
    expect(text).not.toMatch(/\d+ carry this/);
    expect(text).toContain("had similar items, none matched");
    // AC2 — no phantom merchant list above a zero shelf.
    expect(text).not.toContain("Prices from");
    // AC3 — no "Accessories for this product" band on a page with no product.
    expect(document.querySelector('[data-accessory-band="true"]')).toBeNull();
    expect(text).not.toContain("Accessories for this product");
    // No query-term match at all → no unrelated recovery padding.
    expect(document.querySelector('[data-recovery-band="true"]')).toBeNull();
  });

  it("says the same in Arabic (RTL chrome)", async () => {
    await act(async () => {
      renderZero(XYZZY, "xyzzy no such thing", "ar");
    });
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("لا توجد مطابقة");
    expect(text).toContain("لا أحد يوفّر هذا");
    expect(text).toContain("عناصر مشابهة");
    expect(text).not.toContain("الأسعار من");
    expect(document.querySelector('[data-accessory-band="true"]')).toBeNull();
  });
});

describe("REEA-1247 AC4 — nearest in-market recovery", () => {
  it("renders ≤5 live in-market matches, each labelled with the matched term", async () => {
    await act(async () => {
      renderZero(DYSON, "dyson airwrap case", "en");
    });
    const band = document.querySelector('[data-recovery-band="true"]') as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.getAttribute("aria-label")).toBe("You might also like");
    const items = Array.from(band.querySelectorAll("[data-recovery-item]"));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    for (const item of items) {
      expect(item.getAttribute("data-recovery-market")).toBe("KW");
      expect(item.getAttribute("data-recovery-term")).toBe("dyson");
      expect(item.textContent).toContain("Closest match: “dyson”");
      // The rendered price is a real Kuwait offer from this run.
      expect(item.textContent).toMatch(/KD|د\.ك/);
    }
    // No foreign row on this page: the Kindle's SAR offer carries no term.
    expect(document.querySelector('[data-foreign-band="true"]')).toBeNull();
  });

  it("keeps the Arabic recovery band and matched-term label", async () => {
    await act(async () => {
      renderZero(DYSON, "dyson airwrap case", "ar");
    });
    const band = document.querySelector('[data-recovery-band="true"]') as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.textContent).toContain("قد يعجبك أيضًا");
    expect(band.textContent).toContain("أقرب مطابقة: «dyson»");
  });
});

describe("REEA-1247 AC5 — nothing in market is stated, foreign offers separated", () => {
  it("says 'Not stocked in Kuwait' and keeps the foreign band apart", async () => {
    await act(async () => {
      renderZero(SONY_FOREIGN, "sony wh-1000xm6 ear pads", "en");
    });
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Not stocked in Kuwait");
    expect(document.querySelector('[data-recovery-band="true"]')).toBeNull();
    const foreign = document.querySelector('[data-foreign-band="true"]') as HTMLElement;
    expect(foreign).not.toBeNull();
    expect(foreign.getAttribute("aria-label")).toBe("Available outside Kuwait");
    const rows = Array.from(foreign.querySelectorAll("[data-foreign-item]"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) {
      expect(row.getAttribute("data-market")).toBe("SA");
      expect(row.getAttribute("data-recovery-term")).toBe("sony");
    }
    // The Dyson row carries no query term — it is not padded into recovery.
    expect(text).not.toContain("Dyson Airwrap");
  });

  it("states it in Arabic too", async () => {
    await act(async () => {
      renderZero(SONY_FOREIGN, "sony wh-1000xm6 ear pads", "ar");
    });
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("غير متوفر في الكويت");
    expect(text).toContain("متوفر خارج الكويت");
  });
});
